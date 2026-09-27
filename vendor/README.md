# WebMCP package

`jason.today-webmcp-0.1.13.tgz` is the MIT-licensed upstream `@jason.today/webmcp` 0.1.13 package. Its only change is removing the `http` dependency from `package.json`. The package code imports Node's built-in `http` module, so the npm `http` package is unnecessary and is flagged by OSV as `MAL-2025-22760`.

The browser widget and local MCP bridge CLI are the original upstream files. The package retains its upstream license.
