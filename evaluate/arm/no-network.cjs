// Targeted hidden tests are offline, including subprocesses inheriting NODE_OPTIONS.
const { syncBuiltinESMExports } = require("node:module");
const deny = () => { throw new Error("Network disabled during evaluation grading"); };
for (const name of ["http", "https"]) {
  const mod = require(`node:${name}`); mod.request = deny; mod.get = deny;
}
const net = require("node:net"); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
require("node:tls").connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
