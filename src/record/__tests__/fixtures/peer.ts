import { existsSync } from "node:fs";
import { openRecord } from "../../index.js";

const [home, worker] = process.argv.slice(2);
const record = openRecord({ home, isNetwork: () => false });
const insert = record.db.prepare("INSERT INTO settings(scope,key,value) VALUES('concurrent',?,?)");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
while (!existsSync(`${home}/start`)) await sleep(2);
for (let index = 0; index < 150; index++) {
  insert.run(`${worker}-${index}`, `${index}`);
  await sleep(2);
}
let seen = 0;
for (let attempt = 0; attempt < 2500; attempt++) {
  seen = Number(record.db.prepare("SELECT count(*) AS n FROM settings WHERE scope='concurrent'").get()!.n);
  if (seen === 300) break;
  await sleep(2);
}
record.close();
process.stdout.write(JSON.stringify({ seen }));
