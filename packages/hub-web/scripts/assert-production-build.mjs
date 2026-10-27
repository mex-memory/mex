import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(packageRoot, "../../dist/hub");
const manifestPath = join(outputRoot, ".vite", "manifest.json");
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const maxJavaScriptChunkBytes = 500_000;

if (/fixture-api|src\/dev\//i.test(manifestText)) {
  throw new Error("The production Hub manifest contains a development fixture module.");
}

const lazyWorkbenchSources = [
  "src/pages/HomePage.tsx",
  "src/pages/SearchPage.tsx",
  "src/pages/KnowledgePage.tsx",
  "src/pages/SymbolPage.tsx",
  "src/pages/CapabilityPage.tsx",
  "src/pages/WorkstreamsPage.tsx",
  "src/pages/SpecsPage.tsx",
  "src/pages/InboxPage.tsx",
  "src/pages/RelayPage.tsx",
  "src/pages/MembersPage.tsx",
  "src/pages/ActivityPage.tsx",
  "src/pages/JobsPage.tsx",
  "src/pages/HealthPage.tsx",
  "src/pages/SetupPage.tsx",
];
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) throw new Error("The production Hub manifest has no application entry.");
const initialChunks = staticImportClosure(entryKey);
const initialDynamicImports = new Set(
  [...initialChunks].flatMap((key) => manifest[key]?.dynamicImports ?? []),
);
const workbenchEntries = lazyWorkbenchSources.map((source) => {
  const expectedName = source.slice(source.lastIndexOf("/") + 1, source.lastIndexOf("."));
  const key = Object.keys(manifest).find((candidate) => (
    candidate === source
    || manifest[candidate].src === source
    || manifest[candidate].name === expectedName
  ));
  if (!key) throw new Error(`The production Hub manifest has no route chunk for ${source}.`);
  if (!manifest[key].isDynamicEntry || !initialDynamicImports.has(key)) {
    throw new Error(`The production Hub route ${source} is not loaded through a lazy workbench boundary.`);
  }
  if (initialChunks.has(key)) {
    throw new Error(`The production Hub entry eagerly loads workbench route ${source}.`);
  }
  return { key, source, file: manifest[key].file };
});
const homeEntry = workbenchEntries.find((entry) => entry.source === "src/pages/HomePage.tsx");
if (!homeEntry || workbenchEntries.some((entry) => entry !== homeEntry && entry.file === homeEntry.file)) {
  throw new Error("The production Hub Home workbench is not isolated in its own lazy chunk.");
}
const homeChunks = staticImportClosure(homeEntry.key);
const teamAccessDialogKey = Object.keys(manifest).find((candidate) => (
  candidate === "src/pages/TeamAccessDialog.tsx"
  || manifest[candidate].src === "src/pages/TeamAccessDialog.tsx"
));
// The card is shared with Setup and Relays, so its dialog import may live in a
// shared chunk that Home loads statically; it must still be loaded only on demand.
if (
  !teamAccessDialogKey
  || !manifest[teamAccessDialogKey].isDynamicEntry
  || ![...homeChunks].some((key) => (manifest[key]?.dynamicImports ?? []).includes(teamAccessDialogKey))
  || homeChunks.has(teamAccessDialogKey)
  || initialChunks.has(teamAccessDialogKey)
) {
  throw new Error("The team-access dialog is not isolated behind its explicit open-on-demand boundary.");
}
for (const entry of workbenchEntries) {
  if (entry !== homeEntry && homeChunks.has(entry.key)) {
    throw new Error(`The production Hub Home workbench eagerly imports ${entry.source}.`);
  }
}
const overviewRuntimeKey = Object.keys(manifest).find((candidate) => {
  const record = manifest[candidate] ?? {};
  return record.name === "overview" || [candidate, record.src].some((value) => (
    typeof value === "string" && /(?:^|\/)hub-contracts\/dist\/overview\.js$/u.test(value)
  ));
});
if (!overviewRuntimeKey || !manifest[overviewRuntimeKey].isDynamicEntry) {
  throw new Error("The production Hub manifest has no lazy Overview aggregate validator.");
}
if (initialChunks.has(overviewRuntimeKey)) {
  throw new Error("The Overview aggregate validator leaked into the application shell.");
}
const setupRuntimeKey = Object.keys(manifest).find((candidate) => {
  const record = manifest[candidate] ?? {};
  return record.name === "setup" || [candidate, record.src].some((value) => (
    typeof value === "string" && /(?:^|\/)hub-contracts\/dist\/setup\.js$/u.test(value)
  ));
});
if (!setupRuntimeKey || !manifest[setupRuntimeKey].isDynamicEntry) {
  throw new Error("The production Hub manifest has no lazy Setup contract.");
}
if (initialChunks.has(setupRuntimeKey) || homeChunks.has(setupRuntimeKey)) {
  throw new Error("The Setup contract leaked into the application shell or Home workbench.");
}
const contactRuntimeKey = Object.keys(manifest).find((candidate) => (
  (manifest[candidate].src ?? candidate) === "../hub-contracts/dist/contact.js"
));
if (!contactRuntimeKey || !manifest[contactRuntimeKey].isDynamicEntry
  || initialChunks.has(contactRuntimeKey) || staticImportClosure(contactRuntimeKey).has(setupRuntimeKey)) {
  throw new Error("Contact preferences must load independently of setup and the initial shell.");
}
const relayEntry = workbenchEntries.find((entry) => entry.source === "src/pages/RelayPage.tsx");
const relayComposerKey = Object.keys(manifest).find((candidate) => (
  candidate === "src/pages/RelayDraftComposer.tsx"
  || manifest[candidate].src === "src/pages/RelayDraftComposer.tsx"
));
const relayRuntimeKey = Object.keys(manifest).find((candidate) => {
  const record = manifest[candidate] ?? {};
  return record.name === "relay-client" || [candidate, record.src].some((value) => (
    typeof value === "string" && /(?:^|\/)src\/api\/relay-client\.tsx?$/u.test(value)
  ));
});
if (!relayEntry || !relayRuntimeKey || !relayComposerKey) {
  throw new Error("The production Hub manifest has no private Relay runtime or lazy composer chunk.");
}
if (
  !manifest[relayComposerKey].isDynamicEntry
  || !(manifest[relayEntry.key].dynamicImports ?? []).includes(relayComposerKey)
  || staticImportClosure(relayEntry.key).has(relayComposerKey)
) {
  throw new Error("The Relay draft composer is not isolated behind its open-on-demand boundary.");
}
if (!(manifest[relayEntry.key].imports ?? []).includes(relayRuntimeKey)) {
  throw new Error("The Relay workbench does not directly own its strict runtime contract and transport chunk.");
}
if (initialChunks.has(relayRuntimeKey) || homeChunks.has(relayRuntimeKey)) {
  throw new Error("The strict Relay runtime contracts or transport leaked into the application shell or Home workbench.");
}
const activityEntry = workbenchEntries.find((entry) => entry.source === "src/pages/ActivityPage.tsx");
const activityContextKey = Object.keys(manifest).find((candidate) => (
  candidate === "src/pages/ActivityEntryContext.tsx"
  || manifest[candidate].src === "src/pages/ActivityEntryContext.tsx"
));
if (!activityEntry || !activityContextKey) {
  throw new Error("The production Hub manifest has no expansion-only Activity context chunk.");
}
if (
  !manifest[activityContextKey].isDynamicEntry
  || !(manifest[activityEntry.key].dynamicImports ?? []).includes(activityContextKey)
  || staticImportClosure(activityEntry.key).has(activityContextKey)
) {
  throw new Error("Detailed Activity context is not isolated behind its explicit expansion boundary.");
}
const membersEntry = workbenchEntries.find((entry) => entry.source === "src/pages/MembersPage.tsx");
const membersMutationKey = Object.keys(manifest).find((candidate) => (
  candidate === "src/pages/MembersMutationDialogs.tsx"
  || manifest[candidate].src === "src/pages/MembersMutationDialogs.tsx"
));
if (!membersEntry || !membersMutationKey) {
  throw new Error("The production Hub manifest has no open-on-demand Members mutation chunk.");
}
if (
  !manifest[membersMutationKey].isDynamicEntry
  || !(manifest[membersEntry.key].dynamicImports ?? []).includes(membersMutationKey)
  || staticImportClosure(membersEntry.key).has(membersMutationKey)
) {
  throw new Error("Members mutation dialogs are not isolated behind their explicit review boundary.");
}
if (initialChunks.has(membersMutationKey) || homeChunks.has(membersMutationKey)) {
  throw new Error("Members mutation dialogs leaked into the application shell or Home workbench.");
}
if (Object.entries(manifest).some(([key, record]) => (
  [key, record?.src, record?.name].some((value) => (
    typeof value === "string" && /(?:^|\/)ActivityRecordDialog(?:\.tsx)?$/u.test(value)
  ))
))) {
  throw new Error("The read-only production Activity workbench still contains a browser recorder chunk.");
}
for (const key of homeChunks) {
  const record = manifest[key] ?? {};
  const identity = [key, record.src, record.name, record.file].filter(Boolean).join("\n");
  if (/(?:^|\/)setup(?:\/|\.|$)/iu.test(identity)) {
    throw new Error(`The production Hub Home workbench eagerly imports setup code through ${key}.`);
  }
}

const forbiddenFixtureData = [
  "job_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Three knowledge pages lost grounding",
  "scf_mex",
  "event_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Keep activity immutable and preserve Project notes",
  "Project Hub read boundaries",
  "mx_01K36WVM6H7JK8M9NPQRSTVVWX",
  "member_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Release benchmark local draft Requirement",
  "Release benchmark pending Spec update",
  "inbox_00000000000000000000000000000001",
  "proposal_01000000000000000000001720",
  "mx_01000000000000000000000001",
  "relay-draft-01",
  "relay_01000000000000000000000001",
  "Exact fixture evidence for Relay UI validation.",
];

for (const file of filesUnder(outputRoot)) {
  const bytes = readFileSync(file);
  if (file.endsWith(".js") && statSync(file).size > maxJavaScriptChunkBytes) {
    throw new Error(
      `The production Hub JavaScript chunk ${file} exceeds ${maxJavaScriptChunkBytes} bytes.`,
    );
  }
  for (const sentinel of ["react.development.js", "Download the React DevTools"]) {
    if (file.endsWith(".js") && bytes.includes(Buffer.from(sentinel))) {
      throw new Error(`The production Hub asset ${file} contains the React development runtime.`);
    }
  }
  for (const sentinel of forbiddenFixtureData) {
    if (bytes.includes(Buffer.from(sentinel))) {
      throw new Error(`The production Hub asset ${file} contains development fixture data.`);
    }
  }
}

function* filesUnder(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

function staticImportClosure(entryKey) {
  const seen = new Set();
  const pending = [entryKey];
  while (pending.length) {
    const key = pending.pop();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pending.push(...(manifest[key]?.imports ?? []));
  }
  return seen;
}
