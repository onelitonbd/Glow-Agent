import {
  cloneGithubRepo,
  commitGithub,
  pluginRepositories,
  pushGithub,
  repoDeleteFile,
  repoListFiles,
  repoReadFile,
  repoRenameFile,
  repoWriteFile
} from './plugins.js';

function toolDefinition(id, name, description, properties, required = []) {
  return {
    id,
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
  };
}

export function githubToolDefinitions() {
  return [
    toolDefinition('github_list_repos', 'GitHub list repos', 'List repositories for signed-in GitHub account. Use to discover repos. No params needed. Returns up to 50 repos with names, owners, descriptions.', {}, []),
    toolDefinition('github_clone', 'GitHub clone repo', 'Clone or update selected repository into local workspace (data/workspace/repos/). Call this first before using other github_* file tools if repo not yet cloned. No params needed - uses selected repo from plugin settings.', {}, []),
    toolDefinition('github_list_files', 'GitHub list files', 'List files and folders in cloned repository. Path RELATIVE to repo root, e.g. "" for root, "src" for subfolder. Use to discover files before reading. Example path "src"', { path: { type: 'string', description: 'Directory path RELATIVE to repo root, e.g. "" for root or "src". Defaults to root.' } }, []),
    toolDefinition('github_read_file', 'GitHub read file', 'Read text file from cloned repository. Path RELATIVE to repo root, e.g. "README.md" or "src/app.js". Use github_list_files first to find files.', { path: { type: 'string', description: 'File path RELATIVE to repo root, e.g. "README.md".' } }, ['path']),
    toolDefinition('github_write_file', 'GitHub write file', 'Create or overwrite file in cloned repo. Path RELATIVE to repo root. Content is full file text. Parents auto-created. Example path "src/new.js", content "console.log(1)".', { path: { type: 'string', description: 'File path RELATIVE to repo root, e.g. "src/app.js".' }, content: { type: 'string', description: 'Full file content to write.' } }, ['path', 'content']),
    toolDefinition('github_rename_file', 'GitHub rename file', 'Rename or move file within cloned repo. Both from and to RELATIVE to repo root. Destination must not exist. Example from "old.js" to "new.js".', { from: { type: 'string', description: 'Current path RELATIVE to repo root.' }, to: { type: 'string', description: 'New path RELATIVE to repo root.' } }, ['from', 'to']),
    toolDefinition('github_delete_file', 'GitHub delete file', 'Delete file from cloned repo. Path RELATIVE to repo root, e.g. "old.txt". Irreversible locally until committed.', { path: { type: 'string', description: 'File path RELATIVE to repo root.' } }, ['path']),
    toolDefinition('github_commit', 'GitHub commit', 'Stage and commit current changes in cloned repo locally (does not push). Use after making file changes. Message is commit message, e.g. "Add new feature".', { message: { type: 'string', description: 'Commit message describing changes, e.g. "Fix bug in auth".' } }, []),
    toolDefinition('github_push', 'GitHub push', 'Push local commits to GitHub. REQUIRES user confirmation - if blocked, tell user to approve writes in chat UI and stop retrying. Message is short note for user explaining what will be pushed.',
      { message: { type: 'string', description: 'Short note for user explaining push, e.g. "Pushing fix for auth bug".' } }, [])
  ];
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    // Try fix single quotes
    try {
      const fixed = trimmed.replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    return {};
  }
}

function summary(call, result) {
  const id = call.function?.name || call.name || '';
  if (!result || result.error) return `${id} could not run: ${result?.error || 'unknown error'}`;
  if (id === 'github_list_repos') return `GitHub repos: ${result.count} repositories`;
  if (id === 'github_clone') return `Cloned ${result.repository} (${result.status})`;
  if (id === 'github_list_files') return `Listed files in ${result.repository || 'repo'} (${result.entries?.length || 0} entries)`;
  if (id === 'github_read_file') return `Read ${result.path} from ${result.repository}`;
  if (id === 'github_write_file') return `Wrote ${result.path} (${result.bytes} bytes)`;
  if (id === 'github_rename_file') return `Renamed ${result.from} -> ${result.to}`;
  if (id === 'github_delete_file') return `Deleted ${result.path}`;
  if (id === 'github_commit') return result.committed === false ? `No changes to commit in ${result.directory}` : `Committed changes in ${result.directory}`;
  if (id === 'github_push') return `Pushed ${result.repository} (${result.branch})`;
  return id;
}

export async function executeGithubTool(call, ctx) {
  const id = call.function?.name || call.name || '';
  const rawArgs = call.function?.arguments ?? call.arguments;
  const args = parseArgs(rawArgs);
  let result;
  const { db, pluginId, workspaceDirectory } = ctx;
  if (!pluginId) {
    return { toolId: id, result: { error: 'GitHub plugin not configured. Enable local clone in Plugins settings and select a repository.' }, summary: `${id} failed: no plugin` };
  }
  try {
    if (id === 'github_list_repos') {
      const repos = await pluginRepositories(db, pluginId);
      result = { count: repos.length, repos: repos.slice(0, 50) };
    } else if (id === 'github_clone') {
      result = await cloneGithubRepo(db, pluginId, workspaceDirectory);
    } else if (id === 'github_list_files') {
      result = repoListFiles(db, pluginId, workspaceDirectory, args.path);
    } else if (id === 'github_read_file') {
      if (!args.path) {
        result = { error: 'path is required, e.g. "README.md". Use github_list_files first.' };
      } else {
        result = repoReadFile(db, pluginId, workspaceDirectory, args.path);
      }
    } else if (id === 'github_write_file') {
      if (!args.path || args.content === undefined) {
        result = { error: 'path and content required. Path e.g. "src/app.js", content is full file text.' };
      } else {
        result = repoWriteFile(db, pluginId, workspaceDirectory, args.path, args.content);
      }
    } else if (id === 'github_rename_file') {
      if (!args.from || !args.to) {
        result = { error: 'from and to paths required, both relative to repo root.' };
      } else {
        result = repoRenameFile(db, pluginId, workspaceDirectory, args.from, args.to);
      }
    } else if (id === 'github_delete_file') {
      if (!args.path) {
        result = { error: 'path required' };
      } else {
        result = repoDeleteFile(db, pluginId, workspaceDirectory, args.path);
      }
    } else if (id === 'github_commit') {
      result = await commitGithub(db, pluginId, workspaceDirectory, { message: args.message });
    } else if (id === 'github_push') {
      result = await pushGithub(db, pluginId, workspaceDirectory);
    } else {
      result = { error: `Unknown GitHub tool: ${id}` };
    }
  } catch (error) {
    result = { error: error.message };
  }
  return { toolId: id, result, summary: summary(call, result) };
}
