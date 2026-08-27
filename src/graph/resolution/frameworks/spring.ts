import { parse } from "../../extraction/grammars.js";
import { generateNodeId, getChildByField, getNodeText } from "../../extraction/node-id.js";
import type { TSNode } from "../../extraction/types.js";
import type { GraphNode } from "../../types.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const SPRING_REF_MARKER = "spring:di";

const COMPONENT_ANNOTATIONS = new Set([
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "Configuration",
  "SpringBootApplication",
  "ControllerAdvice",
  "RestControllerAdvice",
]);

const INJECTION_ANNOTATIONS = new Set([
  "Autowired",
  "Inject",
  "Resource",
]);

const REQUIRED_ARGS_ANNOTATIONS = new Set([
  "RequiredArgsConstructor",
  "AllArgsConstructor",
]);

const BEAN_ANNOTATIONS = new Set(["Bean"]);
const QUALIFIER_ANNOTATIONS = new Set(["Qualifier", "Named", "Resource"]);
const ANNOTATION_TYPES = new Set(["annotation", "marker_annotation"]);
const MODIFIER_TYPES = new Set(["modifiers"]);

interface BeanCandidate {
  node: GraphNode;
  beanNames: Set<string>;
  typeNames: Set<string>;
  primary: boolean;
}

interface SpringBeanIndex {
  candidates: BeanCandidate[];
}

const indexCache = new WeakMap<ResolutionContext, SpringBeanIndex>();

export const springResolver: FrameworkResolver = {
  name: "spring",
  languages: ["java"],

  detect(context) {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
      const content = context.readFile(file);
      if (content && /\b(org\.springframework|spring-boot|spring-context|spring-web)\b/.test(content)) {
        return true;
      }
    }

    return context.getAllFiles().some((file) => {
      if (!file.endsWith(".java")) return false;
      const content = context.readFile(file);
      return Boolean(content && /\b(org\.springframework|jakarta\.inject|javax\.inject|@SpringBootApplication)\b/.test(content));
    });
  },

  extract(filePath, content): FrameworkExtractionResult {
    const references: UnresolvedRef[] = [];
    if (!filePath.endsWith(".java")) return { nodes: [], references };
    const tree = parse(content, "java");
    if (!tree) return { nodes: [], references };

    const visit = (node: TSNode): void => {
      if (isTypeDeclaration(node)) {
        extractTypeReferences(filePath, content, node, references);
        return;
      }
      for (const child of node.namedChildren) visit(child);
    };

    visit(tree.rootNode);
    return { nodes: [], references };
  },

  resolve(ref, context): ResolvedRef | null {
    if (!ref.candidates?.includes(SPRING_REF_MARKER)) return null;
    const targetType = lastSegment(ref.referenceName);
    if (!targetType) return null;

    const index = springIndex(context);
    const qualifier = ref.candidates
      .find((candidate) => candidate.startsWith("qualifier:"))
      ?.slice("qualifier:".length);

    const matchingType = index.candidates.filter((candidate) => candidate.typeNames.has(targetType));
    const qualified = qualifier
      ? matchingType.filter((candidate) => candidate.beanNames.has(qualifier))
      : matchingType;
    const target = pickBeanCandidate(qualified);
    if (target) {
      return { original: ref, targetNodeId: target.node.id, confidence: 0.95, resolvedBy: "framework" };
    }

    const fallback = context.getNodesByName(targetType)
      .filter((node) => node.kind === "class" || node.kind === "interface");
    if (fallback.length === 1) {
      return { original: ref, targetNodeId: fallback[0]!.id, confidence: 0.75, resolvedBy: "framework" };
    }

    return null;
  },
};

function extractTypeReferences(
  filePath: string,
  source: string,
  typeNode: TSNode,
  references: UnresolvedRef[],
): void {
  const className = nameOf(typeNode, source);
  if (!className) return;
  const classId = generateNodeId(filePath, typeKind(typeNode), className);
  const annotations = annotationsOf(typeNode, source);
  const isComponent = annotations.some((annotation) => COMPONENT_ANNOTATIONS.has(annotation.name));
  const useRequiredArgs = isComponent &&
    annotations.some((annotation) => REQUIRED_ARGS_ANNOTATIONS.has(annotation.name));

  const body = getChildByField(typeNode, "body") ?? typeNode.namedChildren.find((child) =>
    child.type === "class_body" ||
    child.type === "interface_body" ||
    child.type === "enum_body" ||
    child.type === "annotation_type_body"
  );
  if (!body) return;

  const fields = body.namedChildren.filter((child) => child.type === "field_declaration");
  const constructors = body.namedChildren.filter((child) => child.type === "constructor_declaration");
  const methods = body.namedChildren.filter((child) => child.type === "method_declaration");

  for (const field of fields) {
    const fieldAnnotations = annotationsOf(field, source);
    const injected =
      fieldAnnotations.some((annotation) => INJECTION_ANNOTATIONS.has(annotation.name)) ||
      (useRequiredArgs && hasModifier(field, "final", source) && !hasModifier(field, "static", source));
    if (!injected) continue;
    const qualifier = qualifierOf(fieldAnnotations);
    for (const target of targetsFromTypeField(field, source)) {
      addSpringRef(references, classId, target, filePath, field, qualifier);
    }
  }

  const constructorInjection =
    isComponent && constructors.length === 1
      ? new Set([constructors[0]])
      : new Set<TSNode>();
  for (const ctor of constructors) {
    if (
      constructorInjection.has(ctor) ||
      annotationsOf(ctor, source).some((annotation) => INJECTION_ANNOTATIONS.has(annotation.name))
    ) {
      addParameterRefs(references, classId, filePath, source, ctor);
    }
  }

  for (const method of methods) {
    const methodAnnotations = annotationsOf(method, source);
    if (methodAnnotations.some((annotation) => INJECTION_ANNOTATIONS.has(annotation.name))) {
      addParameterRefs(references, classId, filePath, source, method);
    }
    if (methodAnnotations.some((annotation) => BEAN_ANNOTATIONS.has(annotation.name))) {
      const methodName = nameOf(method, source);
      if (!methodName) continue;
      const methodId = generateNodeId(filePath, "method", methodName);
      addParameterRefs(references, methodId, filePath, source, method);
    }
  }
}

function addParameterRefs(
  references: UnresolvedRef[],
  sourceId: string,
  filePath: string,
  source: string,
  callable: TSNode,
): void {
  const params = getChildByField(callable, "parameters");
  if (!params) return;
  for (const param of params.namedChildren) {
    if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
    const qualifier = qualifierOf(annotationsOf(param, source));
    const typeNode = getChildByField(param, "type");
    if (!typeNode) continue;
    for (const target of typeTargets(getNodeText(typeNode, source))) {
      addSpringRef(references, sourceId, target, filePath, param, qualifier);
    }
  }
}

function addSpringRef(
  references: UnresolvedRef[],
  fromNodeId: string,
  targetName: string,
  filePath: string,
  node: TSNode,
  qualifier?: string,
): void {
  if (!targetName || JAVA_CONTAINER_TYPES.has(targetName)) return;
  references.push({
    fromNodeId,
    referenceName: targetName,
    referenceKind: "references",
    filePath,
    language: "java",
    line: node.startPosition.row,
    column: node.startPosition.column,
    candidates: qualifier ? [SPRING_REF_MARKER, `qualifier:${qualifier}`] : [SPRING_REF_MARKER],
  });
}

function springIndex(context: ResolutionContext): SpringBeanIndex {
  const cached = indexCache.get(context);
  if (cached) return cached;

  const candidates: BeanCandidate[] = [];
  for (const node of context.getNodesByKind("class")) {
    if (node.language !== "java") continue;
    const annotations = node.decorators ?? [];
    if (!annotations.some((annotation) => COMPONENT_ANNOTATIONS.has(annotation))) continue;
    const source = context.readFile(node.filePath);
    const slice = source ? nodeSourceSlice(source, node) : "";
    const beanNames = new Set<string>([decapitalize(node.name)]);
    for (const value of annotationValues(slice, [...COMPONENT_ANNOTATIONS])) beanNames.add(value);
    const typeNames = new Set<string>([node.name, ...declaredHeaderTypes(slice)]);
    candidates.push({
      node,
      beanNames,
      typeNames,
      primary: annotations.includes("Primary") || /@Primary\b/.test(slice),
    });
  }

  for (const node of context.getNodesByKind("method")) {
    if (node.language !== "java" || !node.decorators?.includes("Bean")) continue;
    const source = context.readFile(node.filePath);
    const slice = source ? nodeSourceSlice(source, node) : "";
    const beanNames = new Set<string>([node.name]);
    for (const value of annotationValues(slice, ["Bean", "Named", "Qualifier"])) beanNames.add(value);
    const typeNames = new Set<string>();
    if (node.returnType) typeNames.add(lastSegment(node.returnType));
    candidates.push({
      node,
      beanNames,
      typeNames,
      primary: node.decorators?.includes("Primary") || /@Primary\b/.test(slice),
    });
  }

  const index = { candidates };
  indexCache.set(context, index);
  return index;
}

function pickBeanCandidate(candidates: BeanCandidate[]): BeanCandidate | null {
  if (candidates.length === 1) return candidates[0]!;
  const primary = candidates.filter((candidate) => candidate.primary);
  if (primary.length === 1) return primary[0]!;
  return null;
}

function isTypeDeclaration(node: TSNode): boolean {
  return node.type === "class_declaration" ||
    node.type === "interface_declaration" ||
    node.type === "enum_declaration" ||
    node.type === "record_declaration";
}

function typeKind(node: TSNode): GraphNode["kind"] {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  return "class";
}

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function targetsFromTypeField(node: TSNode, source: string): string[] {
  const typeNode = getChildByField(node, "type");
  return typeNode ? typeTargets(getNodeText(typeNode, source)) : [];
}

function typeTargets(rawType: string): string[] {
  const names = new Set<string>();
  const cleaned = rawType.replace(/@\w+(?:\([^)]*\))?/g, " ");
  const re = /[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/g;
  for (const match of cleaned.matchAll(re)) {
    const name = lastSegment(match[0]!);
    if (!JAVA_CONTAINER_TYPES.has(name)) names.add(name);
  }
  return [...names];
}

function declaredHeaderTypes(sourceSlice: string): string[] {
  const header = sourceSlice.split("{", 1)[0] ?? "";
  const matches = header.match(/\b(?:extends|implements)\s+([^{]+)/);
  return matches ? typeTargets(matches[1]!) : [];
}

function annotationsOf(node: TSNode, source: string): Array<{ name: string; text: string }> {
  const modifiers = node.namedChildren.find((child) => MODIFIER_TYPES.has(child.type));
  if (!modifiers) return [];
  return modifiers.namedChildren
    .filter((child) => ANNOTATION_TYPES.has(child.type))
    .map((child) => ({
      name: annotationName(child, source),
      text: getNodeText(child, source),
    }))
    .filter((annotation) => Boolean(annotation.name));
}

function annotationName(node: TSNode, source: string): string {
  const nameNode = node.namedChildren.find((child) =>
    child.type === "identifier" ||
    child.type === "scoped_identifier" ||
    child.type === "type_identifier" ||
    child.type === "scoped_type_identifier"
  );
  return nameNode ? lastSegment(getNodeText(nameNode, source)) : "";
}

function qualifierOf(annotations: Array<{ name: string; text: string }>): string | undefined {
  for (const annotation of annotations) {
    if (!QUALIFIER_ANNOTATIONS.has(annotation.name)) continue;
    const values = annotationValues(annotation.text, [annotation.name]);
    if (values.length > 0) return values[0];
  }
  return undefined;
}

function annotationValues(source: string, names: string[]): string[] {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`@(?:${escaped})\\s*\\(([^)]*)\\)`, "g");
  const values: string[] = [];
  for (const match of source.matchAll(re)) {
    for (const stringMatch of match[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      values.push(stringMatch[1] ?? stringMatch[2] ?? "");
    }
  }
  return values.filter(Boolean);
}

function hasModifier(node: TSNode, keyword: string, source: string): boolean {
  const modifiers = node.namedChildren.find((child) => MODIFIER_TYPES.has(child.type));
  return Boolean(modifiers?.children.some((child) => getNodeText(child, source) === keyword));
}

function nodeSourceSlice(source: string, node: GraphNode): string {
  const lines = source.split("\n");
  return lines.slice(Math.max(0, node.startLine - 1), node.endLine).join("\n");
}

function decapitalize(name: string): string {
  if (!name) return name;
  if (name.length > 1 && name[0] === name[0]!.toUpperCase() && name[1] === name[1]!.toUpperCase()) {
    return name;
  }
  return name[0]!.toLowerCase() + name.slice(1);
}

function lastSegment(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot < 0 ? value : value.slice(dot + 1);
}

const JAVA_CONTAINER_TYPES = new Set([
  "Class",
  "Collection",
  "Iterable",
  "List",
  "Map",
  "Object",
  "Optional",
  "Provider",
  "Set",
  "Supplier",
  "String",
]);
