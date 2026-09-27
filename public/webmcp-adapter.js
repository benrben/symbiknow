// @jason.today/webmcp@0.1.13 (MIT) ships a classic browser script that
// declares WebMCP globally but does not assign it as a window property.
// Load this adapter after the package script to expose the constructor.
window.WebMCP = WebMCP;
