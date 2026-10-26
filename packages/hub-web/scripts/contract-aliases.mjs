import { resolve } from "node:path";

export function hubContractAliases(packageRoot, command) {
  const source = command === "build"
    ? "../hub-contracts/dist"
    : "../hub-contracts/src";
  const extension = command === "build" ? "js" : "ts";
  return {
    "@mex/hub-contracts/statechart": resolve(packageRoot, source, `statechart.${extension}`),
    "@mex/hub-contracts/ids": resolve(packageRoot, source, `ids.${extension}`),
    "@mex/hub-contracts/overview": resolve(packageRoot, source, `overview.${extension}`),
    "@mex/hub-contracts/contact": resolve(packageRoot, source, `contact.${extension}`),
    "@mex/hub-contracts/setup": resolve(packageRoot, source, `setup.${extension}`),
    "@mex/hub-contracts/relay": resolve(packageRoot, source, `relay.${extension}`),
    "@mex/hub-contracts": resolve(packageRoot, source, `index.${extension}`),
  };
}
