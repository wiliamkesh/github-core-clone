// GraphQL v4 surface (POST /api/graphql). Hand-rolled parser + executor for
// the suite's 18 fixed documents — no general GraphQL engine needed, but the
// parser handles the full shapes those documents use: variables, aliases,
// inline fragments, inline enum lists and input objects, batching.
// See ~/workspace/makefun/gcc-specs/graphql.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  VIEWER,
  decodeGlobalId,
  encodeGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():[]=@{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableNames: string[];
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private peekIsPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }
  private peekIsName(value: string): boolean {
    const t = this.peek();
    return t.kind === 'name' && t.value === value;
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected '${value}', got ${JSON.stringify(t)}`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ operation: 'query', name: null, variableNames: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        const operation = t.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableNames = this.parseVariableDefinitions();
        this.skipDirectives();
        ops.push({ operation, name, variableNames, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        // Named fragments are never sent by the suite; parse + discard.
        this.next();
        this.expectName();
        this.expectName(); // 'on'
        this.expectName();
        this.skipDirectives();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(t)} at top level`);
    }
    return ops;
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (!this.acceptPunct('(')) return names;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      names.push(this.expectName());
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) this.parseValue();
    }
    return names;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.peekIsPunct('@')) {
      this.next();
      this.expectName();
      if (this.peekIsPunct('(')) {
        this.next();
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      sels.push(this.parseSelection());
    }
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peekIsPunct('...')) {
      this.next();
      if (this.peekIsName('on')) {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      // Fragment spread: name only; the suite never sends these.
      this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: '', selectionSet: [] };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peekIsPunct('{')) {
      selectionSet = this.parseSelectionSet();
    }
    return { alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.peekIsPunct(']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.peekIsPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function resolveValue(node: ValueNode, variables: Record<string, JsonValue>): JsonValue {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema knowledge (only what the 18 documents exercise)
// ---------------------------------------------------------------------------
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

function issueCursor(number: number): string {
  return encodeGlobalId('cursor', number);
}
function parseCursor(cursor: string): number | null {
  const parts = decodeGlobalId(cursor);
  if (!parts || parts[0] !== 'cursor' || parts.length < 2) return null;
  const n = parseInt(parts[1], 10);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Ctx {
  store: Store;
  variables: Record<string, JsonValue>;
  errors: GqlError[];
}

function findRepoByDatabaseId(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return undefined;
}

/** Decode a global id of the expected type; returns the remaining parts or null. */
function decodeTypedId(id: JsonValue, type: string): string[] | null {
  if (typeof id !== 'string') return null;
  const parts = decodeGlobalId(id);
  if (!parts || parts[0] !== type) return null;
  return parts.slice(1);
}

function repoObject(ctx: Ctx, repo: Repo): Record<string, JsonValue> {
  return {
    __typename: 'Repository',
    id: encodeGlobalId('Repository', repo.databaseId),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  } as unknown as Record<string, JsonValue>;
}

function issueObject(repo: Repo, issue: Issue): Record<string, JsonValue> {
  return {
    __typename: 'Issue',
    id: encodeGlobalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    __repo: repo,
    __issue: issue,
  } as unknown as Record<string, JsonValue>;
}

function pullObject(repo: Repo, pr: Pull): Record<string, JsonValue> {
  return {
    __typename: 'PullRequest',
    id: encodeGlobalId('PullRequest', repo.databaseId, pr.number),
    number: pr.number,
    state: pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: 'MERGEABLE',
    __repo: repo,
    __pull: pr,
  } as unknown as Record<string, JsonValue>;
}

function resolveField(
  ctx: Ctx,
  parentType: string,
  parent: Record<string, JsonValue> | null,
  field: FieldNode,
  path: (string | number)[],
): JsonValue {
  const args: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, ctx.variables);

  // Root: Query
  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER.login } as unknown as JsonValue;
    }
    if (field.name === 'repository') {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? (repoObject(ctx, repo) as unknown as JsonValue) : null;
    }
    if (field.name === 'node') {
      const parts = decodeTypedId(args.id, 'Repository');
      if (!parts) return null;
      const repo = findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10));
      return repo ? (repoObject(ctx, repo) as unknown as JsonValue) : null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (name === 'SearchType') {
        return { __typename: '__Type', name, enumValues: SEARCH_TYPE_VALUES.map((v) => ({ name: v })) } as unknown as JsonValue;
      }
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return { __typename: '__Type', name, fields: fields.map((f) => ({ name: f })) } as unknown as JsonValue;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".`, path });
    return null;
  }

  // Mutations
  if (parentType === 'Mutation') {
    return resolveMutation(ctx, field, args, path);
  }

  if (!parent) return null;
  const repo = parent.__repo as unknown as Repo | undefined;

  if (parentType === 'Repository' && repo) {
    switch (field.name) {
      case 'issue': {
        const issue = ctx.store.getIssue(repo, Number(args.number));
        return issue ? (issueObject(repo, issue) as unknown as JsonValue) : null;
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy ?? null) as Record<string, JsonValue> | null;
        const first = typeof args.first === 'number' ? args.first : 100;
        const afterNum = typeof args.after === 'string' ? parseCursor(args.after) : null;
        let list = [...repo.issues];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const desc = orderBy?.direction === 'DESC';
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        if (afterNum !== null) {
          list = list.filter((i) => (desc ? i.number < afterNum : i.number > afterNum));
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        return {
          nodes: page.map((i) => issueObject(repo, i)),
          pageInfo: {
            hasNextPage,
            endCursor: page.length > 0 ? issueCursor(page[page.length - 1].number) : null,
          },
        } as unknown as JsonValue;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const list = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq).slice(0, first);
        return { nodes: list.map((p) => pullObject(repo, p)) } as unknown as JsonValue;
      }
      case 'pullRequest': {
        const pr = ctx.store.getPull(repo, Number(args.number));
        return pr ? (pullObject(repo, pr) as unknown as JsonValue) : null;
      }
    }
  }

  if (parentType === 'PullRequest') {
    const pr = parent.__pull as unknown as Pull | undefined;
    if (field.name === 'files' && pr && repo) {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = ctx.store.pullFiles(repo, pr).slice(0, first);
      return { nodes: files.map((f) => ({ path: f.filename })) } as unknown as JsonValue;
    }
  }

  if (parentType === '__Type') {
    if (field.name === 'fields') {
      const fields = (parent.fields as { name: string }[] | undefined) ?? [];
      return fields as unknown as JsonValue;
    }
    if (field.name === 'enumValues') {
      const values = (parent.enumValues as { name: string }[] | undefined) ?? [];
      return values as unknown as JsonValue;
    }
  }

  // Scalar / nested object fields already present on the parent value.
  if (field.name in parent && field.name !== '__repo' && field.name !== '__issue' && field.name !== '__pull') {
    return parent[field.name];
  }

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path });
  return null;
}

function resolveMutation(ctx: Ctx, field: FieldNode, args: Record<string, JsonValue>, path: (string | number)[]): JsonValue {
  const input = (args.input ?? {}) as Record<string, JsonValue>;
  switch (field.name) {
    case 'createIssue': {
      const parts = decodeTypedId(input.repositoryId, 'Repository');
      const repo = parts ? findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10)) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found.', path });
        return { __typename: 'CreateIssuePayload', issue: null } as unknown as JsonValue;
      }
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: { number: issue.number, id: encodeGlobalId('Issue', repo.databaseId, issue.number) } } as unknown as JsonValue;
    }
    case 'closeIssue': {
      const parts = decodeTypedId(input.issueId, 'Issue');
      const repo = parts ? findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10)) : undefined;
      const issue = repo && parts ? ctx.store.getIssue(repo, parseInt(parts[1], 10)) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Issue not found.', path });
        return { __typename: 'CloseIssuePayload', issue: null } as unknown as JsonValue;
      }
      ctx.store.patchIssue(repo, issue, { state: 'closed' });
      return {
        __typename: 'CloseIssuePayload',
        issue: { number: issue.number, id: encodeGlobalId('Issue', repo.databaseId, issue.number), state: 'CLOSED' },
      } as unknown as JsonValue;
    }
    case 'createPullRequest': {
      const parts = decodeTypedId(input.repositoryId, 'Repository');
      const repo = parts ? findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10)) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found.', path });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null } as unknown as JsonValue;
      }
      const pr = ctx.store.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!pr) {
        ctx.errors.push({ message: 'Head or base branch not found.', path });
        return { pullRequest: null } as unknown as JsonValue;
      }
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: {
          number: pr.number,
          id: encodeGlobalId('PullRequest', repo.databaseId, pr.number),
          state: 'OPEN',
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
        },
      } as unknown as JsonValue;
    }
    case 'mergePullRequest': {
      const parts = decodeTypedId(input.pullRequestId, 'PullRequest');
      const repo = parts ? findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10)) : undefined;
      const pr = repo && parts ? ctx.store.getPull(repo, parseInt(parts[1], 10)) : undefined;
      if (!repo || !pr) {
        ctx.errors.push({ message: 'Pull request not found.', path });
        return { __typename: 'MergePullRequestPayload', pullRequest: null } as unknown as JsonValue;
      }
      const result = ctx.store.mergePull(repo, pr, String(input.mergeMethod ?? 'SQUASH'));
      if ('error' in result) {
        ctx.errors.push({ message: `Merge failed: ${result.error}.`, path });
        return { pullRequest: null } as unknown as JsonValue;
      }
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: {
          number: pr.number,
          merged: true,
          state: 'CLOSED',
        },
      } as unknown as JsonValue;
    }
    case 'addComment': {
      const parts = decodeTypedId(input.subjectId, 'Issue');
      const repo = parts ? findRepoByDatabaseId(ctx.store, parseInt(parts[0], 10)) : undefined;
      const issue = repo && parts ? ctx.store.getIssue(repo, parseInt(parts[1], 10)) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Issue not found.', path });
        return { __typename: 'AddCommentPayload', commentEdge: null } as unknown as JsonValue;
      }
      const comment = ctx.store.addComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          node: { id: encodeGlobalId('IssueComment', repo.databaseId, issue.number, comment.id), body: comment.body },
        },
      } as unknown as JsonValue;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".`, path });
      return null;
  }
}

function executeSelection(
  ctx: Ctx,
  parentType: string,
  parent: Record<string, JsonValue> | null,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && parent?.__typename !== sel.typeCondition) continue;
      Object.assign(out, executeSelection(ctx, parentType, parent, sel.selectionSet, path));
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    const value = resolveField(ctx, parentType, parent, field, fieldPath);
    if (field.selectionSet && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const typeName = String((value as Record<string, JsonValue>).__typename ?? parentType);
      out[key] = executeSelection(ctx, typeName, value as Record<string, JsonValue>, field.selectionSet, fieldPath) as unknown as JsonValue;
    } else if (field.selectionSet && Array.isArray(value)) {
      // A list of objects (e.g. nodes): resolve each element's sub-selections.
      out[key] = value.map((el, i) => {
        if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
          const typeName = String((el as Record<string, JsonValue>).__typename ?? parentType);
          return executeSelection(ctx, typeName, el as Record<string, JsonValue>, field.selectionSet!, [...fieldPath, i]);
        }
        return el;
      }) as unknown as JsonValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, JsonValue>): { data: Record<string, JsonValue> | null; errors?: GqlError[] } {
  const ctx: Ctx = { store, variables, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, op.selectionSet, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(text);
}

/**
 * Handle a GraphQL request. Returns true when the path is /api/graphql
 * (handled, whatever the outcome), false otherwise.
 */
export async function handleGraphql(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (token !== '' && (req.headers.authorization ?? '') !== `Bearer ${token}`) {
    sendJson(store, res, 401, { message: 'Unauthorized' });
    return true;
  }
  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(store, res, 400, { message: 'Malformed JSON in request body' });
    return true;
  }
  const operations = Array.isArray(payload) ? payload : [payload];
  const results: unknown[] = [];
  for (const item of operations) {
    const obj = item as Record<string, unknown>;
    const query = typeof obj.query === 'string' ? obj.query : '';
    const variables = (obj.variables ?? {}) as Record<string, JsonValue>;
    let parsed: OperationNode[];
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] });
      continue;
    }
    if (parsed.length === 0) {
      results.push({ data: null, errors: [{ message: 'No operation provided' }] });
      continue;
    }
    // The suite sends one operation per document; an operationName picks one.
    const opName = typeof obj.operationName === 'string' ? obj.operationName : null;
    const op = opName ? parsed.find((o) => o.name === opName) ?? parsed[0] : parsed[0];
    results.push(executeOperation(store, op, variables));
  }
  sendJson(store, res, 200, Array.isArray(payload) ? results : results[0]);
  return true;
}
