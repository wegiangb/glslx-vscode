var fs = require('fs');
var uri = require('vscode-uri').default;
var path = require('path');
var glslx = require('glslx');
var server = require('vscode-languageserver');

var buildResults = {};
var workspaceRoot = null;
var openDocuments = null;
var connection = null;
var timeout = null;

function reportErrors(callback) {
  try {
    callback();
  } catch (e) {
    var message = e && e.stack || e;
    connection.console.error('glslx: ' + message);
    connection.window.showErrorMessage('glslx: ' + message);
  }
}

function convertRange(range) {
  return {
    start: {
      line: range.start.line,
      character: range.start.column,
    },
    end: {
      line: range.end.line,
      character: range.end.column,
    },
  };
}

function uriToPath(value) {
  var parsed = uri.parse(value);
  return parsed.scheme === 'file' ? path.normalize(parsed.fsPath) : null;
}

function pathToURI(value) {
  return uri.file(value).toString();
}

function sendDiagnostics(diagnostics) {
  var map = {};

  diagnostics.forEach(function(diagnostic) {
    var key = diagnostic.range.source;
    var group = map[key] || (map[key] = []);
    group.push({
      severity: diagnostic.kind === 'error' ? server.DiagnosticSeverity.Error : server.DiagnosticSeverity.Warning,
      range: convertRange(diagnostic.range),
      message: diagnostic.text,
    });
  });

  openDocuments.all().forEach(function(doc) {
    connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: map[doc.uri] || [],
    });
  });
}

function buildLater() {
  clearTimeout(timeout);
  timeout = setTimeout(function() {
    reportErrors(function() {
      var diagnostics = [];
      var results = {};
      var docs = {};

      openDocuments.all().forEach(function(doc) {
        docs[doc.uri] = doc.getText();
      });

      function fileAccess(includeText, relativeURI) {
        var relativePath = uriToPath(relativeURI);
        var absolutePath = relativePath ? path.resolve(path.dirname(path.resolve(relativePath)), includeText) : path.resolve(includeText);

        // In-memory files take precedence
        var absoluteURI = pathToURI(absolutePath);
        if (absoluteURI in docs) {
          return {
            name: absoluteURI,
            contents: docs[absoluteURI],
          };
        }

        // Then try to read from disk
        try {
          return {
            name: absoluteURI,
            contents: fs.readFileSync(absolutePath, 'utf8'),
          };
        } catch (e) {
          return null;
        }
      }

      openDocuments.all().forEach(function(doc) {
        var result = glslx.compileIDE({
          name: doc.uri,
          contents: docs[doc.uri],
        }, {
          fileAccess: fileAccess,
        });
        results[doc.uri] = result;
        diagnostics.push.apply(diagnostics, result.diagnostics);
      });

      buildResults = results;
      sendDiagnostics(diagnostics);
    });
  }, 100);
}

function computeTooltip(request) {
  var result = buildResults[request.textDocument.uri];

  if (result) {
    var response = result.tooltipQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,

      // Visual Studio Code already includes diagnostics and including
      // them in the results causes each diagnostic to be shown twice
      ignoreDiagnostics: true,
    });

    if (response.tooltip !== null) {
      return {
        contents: {
          language: 'glslx',
          value: response.tooltip,
        },
        range: convertRange(response.range),
      }
    }
  }

  return null;
}

function computeDefinitionLocation(request) {
  var result = buildResults[request.textDocument.uri];

  if (result) {
    var response = result.definitionQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    if (response.definition !== null) {
      return {
        uri: response.definition.source,
        range: convertRange(response.definition),
      };
    }
  }

  return null
}

function computeDocumentSymbols(request) {
  var result = buildResults[request.textDocument.uri];

  if (result) {
    var response = result.symbolsQuery({
      source: request.textDocument.uri,
    });

    if (response.symbols !== null) {
      return response.symbols.map(function(symbol) {
        return {
          name: symbol.name,
          kind:
            symbol.kind === 'struct' ? 5 :
            symbol.kind === 'function' ? 12 :
            symbol.kind === 'variable' ? 13 :
            null,
          location: {
            uri: symbol.range.source,
            range: convertRange(symbol.range),
          },
        };
      });
    }
  }

  return null;
}

function computeRenameEdits(request) {
  var result = buildResults[request.textDocument.uri];

  if (result) {
    var response = result.renameQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    if (response.ranges !== null) {
      var documentChanges = [];
      var map = {};

      response.ranges.forEach(function(range) {
        var edits = map[range.source];
        if (!edits) {
          var doc = openDocuments.get(range.source);
          edits = map[range.source] = [];
          if (doc) {
            documentChanges.push({
              textDocument: {uri: range.source, version: doc.version},
              edits, edits,
            });
          }
        }
        edits.push({
          range: convertRange(range),
          newText: request.newName,
        });
      });

      return {
        documentChanges: documentChanges,
      };
    }
  }

  return null;
}

function main() {
  connection = server.createConnection(
    new server.IPCMessageReader(process),
    new server.IPCMessageWriter(process));

  reportErrors(function() {
    // Listen to open documents
    openDocuments = new server.TextDocuments;
    openDocuments.listen(connection);
    openDocuments.onDidChangeContent(buildLater);

    // Grab the workspace when the connection opens
    connection.onInitialize(function(params) {
      workspaceRoot = params.rootPath || null;
      buildLater();
      return {
        capabilities: {
          textDocumentSync: openDocuments.syncKind,
          hoverProvider: true,
          renameProvider: true,
          definitionProvider: true,
          documentSymbolProvider: true,
        },
      };
    });

    // Show tooltips on hover
    connection.onHover(function(request) {
      var tooltip = null;
      reportErrors(function() {
        tooltip = computeTooltip(request);
      });
      return tooltip;
    });

    // Support the "go to definition" feature
    connection.onDefinition(function(request) {
      var location = null;
      reportErrors(function() {
        location = computeDefinitionLocation(request);
      })
      return location;
    });

    // Support the go to symbol feature
    connection.onDocumentSymbol(function(request) {
      var info = null;
      reportErrors(function() {
        info = computeDocumentSymbols(request);
      });
      return info;
    });

    // Support the "rename symbol" feature
    connection.onRenameRequest(function(request) {
      var edits = null;
      reportErrors(function() {
        edits = computeRenameEdits(request);
      });
      return edits;
    });

    // Listen to file system changes for *.glslx files
    connection.onDidChangeWatchedFiles(buildLater);
  });

  connection.listen();
}

main();
