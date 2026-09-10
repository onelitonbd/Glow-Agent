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

// Tool definitions for the OPTIONAL local clone of the selected repository. These are only
// offered when the plugin has "Local clone" enabled; normally the model works directly on
// GitHub through the MCP tools. `commit` and `push` are split so a push always requires
// explicit confirmation from the user (the model cannot approve its own writes).
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
    toolDefinition('github_list_repos', 'GitHub list repos', 'List the repositories for the signed-in GitHub account.', {}, []),
    toolDefinition('github_clone', 'GitHub clone repo', 'Clone (or update) the selected repository into the local workspace so you can work on it.', {}, []),
    toolDefinition('github_list_files', 'GitHub list files', 'List the files and folders in the cloned repository.', { path: { type: 'string', description: 'Directory path relative to the repository root. Defaults to the root.' } }, []),
    toolDefinition('github_read_file', 'GitHub read file', 'Read a text file from the cloned repository.', { path: { type: 'string', description: 'File path relative to the repository root.' } }, ['path']),
    toolDefinition('github_write_file', 'GitHub write file', 'Create or overwrite a file in the cloned repository (edits, rewrites, and new files).', { path: { type: 'string', description: 'File path relative to the repository root.' }, content: { type: 'string', description: 'The file content to write.' } }, ['path', 'content']),
    toolDefinition('github_rename_file', 'GitHub rename file', 'Rename or move a file within the cloned repository.', { from: { type: 'string', description: 'Current path relative to the repository root.' }, to: { type: 'string', description: 'New path relative to the repository root.' } }, ['from', 'to']),
    toolDefinition('github_delete_file', 'GitHub delete file', 'Delete a file from the cloned repository.', { path: { type: 'string', description: 'File path relative to the repository root.' } }, ['path']),
    toolDefinition('github_commit', 'GitHub commit', 'Stage and commit the current changes in the cloned repository locally (does not push).', { message: { type: 'string', description: 'The commit message describing the changes.' } }, []),
    toolDefinition('github_push', 'GitHub push', 'Push local commits to GitHub. This requires explicit confirmation from the user before it runs.',
      { message: { type: 'string', description: 'A short note for the user explaining what will be pushed.' } }, [])
  ];
}

function argumentObject(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function summary(call, result) {
  const id = call.function?.name || '';
  if (!result || result.error) return `${id} could not run: ${result?.error || 'unknown error'}`;
  if (id === 'github_list_repos') return `GitHub repos: ${result.count} repositories`;
  if (id === 'github_clone') return `Cloned ${result.repository} (${result.status})`;
  if (id === 'github_list_files') return `Listed files in ${result.repository || 'repo'} (${result.entries.length} entries)`;
  if (id === 'github_read_file') return `Read ${result.path} from ${result.repository}`;
  if (id === 'github_write_file') return `Wrote ${result.path} (${result.bytes} bytes)`;
  if (id === 'github_rename_file') return `Renamed ${result.from} → ${result.to}`;
  if (id === 'github_delete_file') return `Deleted ${result.path}`;
  if (id === 'github_commit') return result.committed === false ? `No changes to commit in ${result.directory}` : `Committed changes in ${result.directory}`;
  if (id === 'github_push') return `Pushed ${result.repository} (${result.branch})`;
  return id;
}

export async function executeGithubTool(call, ctx) {
  const id = call.function?.name || '';
  const args = argumentObject(call.function?.arguments) || {};
  let result;
  const { db, pluginId, workspaceDirectory } = ctx;
  try {
    if (id === 'github_list_repos') {
      const repos = await pluginRepositories(db, pluginId);
      result = { count: repos.length, repos: repos.slice(0, 50) };
    } else if (id === 'github_clone') {
      result = await cloneGithubRepo(db, pluginId, workspaceDirectory);
    } else if (id === 'github_list_files') {
      result = repoListFiles(db, pluginId, workspaceDirectory, args.path);
    } else if (id === 'github_read_file') {
      result = repoReadFile(db, pluginId, workspaceDirectory, args.path);
    } else if (id === 'github_write_file') {
      result = repoWriteFile(db, pluginId, workspaceDirectory, args.path, args.content);
    } else if (id === 'github_rename_file') {
      result = repoRenameFile(db, pluginId, workspaceDirectory, args.from, args.to);
    } else if (id === 'github_delete_file') {
      result = repoDeleteFile(db, pluginId, workspaceDirectory, args.path);
    } else if (id === 'github_commit') {
      result = await commitGithub(db, pluginId, workspaceDirectory, { message: args.message });
    } else if (id === 'github_push') {
      result = await pushGithub(db, pluginId, workspaceDirectory);
    } else {
      result = { error: 'Unknown GitHub tool.' };
    }
  } catch (error) {
    result = { error: error.message };
  }
  return { toolId: id, result, summary: summary(call, result) };
}
