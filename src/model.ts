export type EvidenceKind = "structural" | "source" | "e2e"
export type CardStyle = "proof" | "editorial" | "signal" | "mental-model"

export interface ProofSection {
  key: string
  label: string
  body: string
}

export interface GweNode {
  id: string
  title: string
  relationship?: string
  pattern: string
  style: CardStyle
  sections: ProofSection[]
  evidence: EvidenceKind
  source: string
  children?: GweNode[]
}

export interface ProofMapDocument {
  version: 2
  revision: number
  root: GweNode
}

export type EditableGweNode = Omit<GweNode, "id" | "children">

export interface VerificationMark {
  verifiedAt: string
}

export interface VerificationState {
  version: 1
  updatedAt: string | null
  verified: Record<string, VerificationMark>
}

export function parseTree(value: unknown): GweNode {
  if (isRecord(value) && value.version === 2 && "root" in value) return parseMapDocument(value).root
  const ids = new Set<string>()
  const tree = parseNode(value, "root", ids)
  if (tree.id !== "G0") throw new Error("The proof tree root must be G0")
  return tree
}

export function parseMapDocument(value: unknown): ProofMapDocument {
  if (isRecord(value) && value.version === 2) {
    if (!Number.isInteger(value.revision) || value.revision < 0) {
      throw new Error("The proof map revision must be a non-negative integer")
    }
    const ids = new Set<string>()
    const root = parseNode(value.root, "root", ids)
    if (root.id !== "G0") throw new Error("The proof tree root must be G0")
    return { version: 2, revision: value.revision, root }
  }
  return { version: 2, revision: 0, root: parseTree(value) }
}

export function parseEditableNode(value: unknown, relationshipRequired = false): EditableGweNode {
  if (!isRecord(value)) throw new Error("Editable GWE content must be an object")

  const textFields = ["title", "source"] as const
  const parsed = {} as Record<(typeof textFields)[number], string>
  for (const field of textFields) {
    const text = value[field]
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`Editable GWE content requires a non-empty ${field}`)
    }
    assertSafeInlineMarkup(text, field)
    parsed[field] = text.trim()
  }

  if (!isEvidence(value.evidence)) throw new Error("Editable GWE content has invalid evidence")
  const pattern = parsePlainLabel(value.pattern ?? "gwe-notes", "pattern")
  const style = parseCardStyle(value.style ?? "proof")
  const sections = value.sections === undefined
    ? parseLegacySections(value, "editable node")
    : parseSections(value.sections, "editable node")
  const relationship = parseRelationship(value.relationship, "editable node", relationshipRequired)

  return {
    title: parsed.title,
    ...(relationship === undefined ? {} : { relationship }),
    pattern,
    style,
    sections,
    evidence: value.evidence,
    source: parsed.source,
  }
}

export function collectNodeIds(root: GweNode): Set<string> {
  const ids = new Set<string>()
  const visit = (node: GweNode) => {
    ids.add(node.id)
    node.children?.forEach(visit)
  }
  visit(root)
  return ids
}

export function parseVerification(value: unknown, validIds: Set<string>): VerificationState {
  if (!isRecord(value) || value.version !== 1 || !(value.updatedAt === null || typeof value.updatedAt === "string") || !isRecord(value.verified)) {
    throw new Error("data/verification.json has an invalid shape")
  }

  const verified: Record<string, VerificationMark> = {}
  for (const [id, mark] of Object.entries(value.verified)) {
    if (!validIds.has(id)) continue
    if (!isRecord(mark) || typeof mark.verifiedAt !== "string") {
      throw new Error(`Verification mark ${id} has an invalid shape`)
    }
    verified[id] = { verifiedAt: mark.verifiedAt }
  }

  return { version: 1, updatedAt: value.updatedAt, verified }
}

function parseNode(value: unknown, location: string, ids: Set<string>): GweNode {
  if (!isRecord(value)) throw new Error(`GWE node ${location} must be an object`)

  const required = ["id", "title", "source"] as const
  for (const field of required) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`GWE node ${location} requires a non-empty ${field}`)
    }
    if (field !== "id") assertSafeInlineMarkup(value[field], field)
  }

  if (!isEvidence(value.evidence)) throw new Error(`GWE node ${value.id} has invalid evidence`)
  if (ids.has(value.id)) throw new Error(`Duplicate GWE node id: ${value.id}`)
  ids.add(value.id)
  const relationship = parseRelationship(value.relationship, `GWE node ${value.id}`, false)

  let children: GweNode[] | undefined
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.length === 0) {
      throw new Error(`GWE node ${value.id} children must be a non-empty array when present`)
    }
    children = value.children.map((child, index) => parseNode(child, `${value.id}.children[${index}]`, ids))
  }

  return {
    id: value.id,
    title: value.title,
    ...(relationship === undefined ? {} : { relationship }),
    pattern: parsePlainLabel(value.pattern ?? "gwe-notes", `${value.id}.pattern`),
    style: parseCardStyle(value.style ?? "proof"),
    sections: value.sections === undefined
      ? parseLegacySections(value, String(value.id))
      : parseSections(value.sections, String(value.id)),
    evidence: value.evidence,
    source: value.source,
    ...(children === undefined ? {} : { children }),
  }
}

function parseRelationship(value: unknown, location: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${location} requires a concise relationship to its parent`)
    return undefined
  }
  if (typeof value !== "string" || /[<>]/.test(value)) {
    throw new Error(`${location} relationship must be plain text`)
  }
  const relationship = value.trim()
  if (relationship === "") {
    if (required) throw new Error(`${location} requires a concise relationship to its parent`)
    return undefined
  }
  if (relationship.length > 180) throw new Error(`${location} relationship must be 180 characters or fewer`)
  return relationship
}

function parseLegacySections(value: Record<string, any>, location: string): ProofSection[] {
  return [
    ["given", "Given"],
    ["when", "When"],
    ["expect", "Expect"],
    ["notes", "Notes"],
  ].map(([key, label]) => {
    const body = value[key]
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error(`GWE node ${location} requires sections or a non-empty ${key}`)
    }
    assertSafeInlineMarkup(body, key)
    return { key, label, body: body.trim() }
  })
}

function parseSections(value: unknown, location: string): ProofSection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error(`${location} sections must contain between 1 and 8 entries`)
  }
  const keys = new Set<string>()
  return value.map((section, index) => {
    if (!isRecord(section)) throw new Error(`${location}.sections[${index}] must be an object`)
    const key = parseSectionKey(section.key, `${location}.sections[${index}].key`)
    if (keys.has(key)) throw new Error(`${location} has duplicate section key: ${key}`)
    keys.add(key)
    const label = parsePlainLabel(section.label, `${location}.sections[${index}].label`)
    if (typeof section.body !== "string" || section.body.trim() === "") {
      throw new Error(`${location}.sections[${index}] requires a non-empty body`)
    }
    assertSafeInlineMarkup(section.body, `${location}.sections[${index}].body`)
    return { key, label, body: section.body.trim() }
  })
}

function parseSectionKey(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${location} must be a lowercase slug`)
  }
  return value
}

function parsePlainLabel(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[<>]/.test(value)) {
    throw new Error(`${location} must be non-empty plain text`)
  }
  return value.trim()
}

function parseCardStyle(value: unknown): CardStyle {
  if (value === "proof" || value === "editorial" || value === "signal" || value === "mental-model") return value
  throw new Error(`Unknown card style: ${String(value)}`)
}

function assertSafeInlineMarkup(value: string, field: string): void {
  const withoutCodeTags = value.replaceAll(/<\/?code>/g, "")
  const openingTags = value.match(/<code>/g)?.length ?? 0
  const closingTags = value.match(/<\/code>/g)?.length ?? 0
  if (withoutCodeTags.includes("<") || withoutCodeTags.includes(">") || openingTags !== closingTags) {
    throw new Error(`${field} only supports plain text and <code> inline markup`)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEvidence(value: unknown): value is EvidenceKind {
  return value === "structural" || value === "source" || value === "e2e"
}
