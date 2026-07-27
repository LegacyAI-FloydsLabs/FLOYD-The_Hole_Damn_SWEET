/**
 * Projects Panel - Manage projects and context files
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { 
  FolderKanban, 
  Plus, 
  File,
  FileText,
  Check,
  X,
  Loader2,
  FolderOpen
} from 'lucide-react';

interface ProjectFile {
  path: string;
  name: string;
  size: number;
  type: 'file' | 'url' | 'snippet';
}

interface Project {
  id: string;
  name: string;
  description: string;
  rootPath?: string;
  files: ProjectFile[];
  instructions?: string;
  created: number;
  updated: number;
}

interface ProjectsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectsPanel({ isOpen, onClose }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [newProject, setNewProject] = useState({
    name: '',
    description: '',
    rootPath: '',
    instructions: '',
  });
  const [newFilePath, setNewFilePath] = useState('');
  const [newSnippet, setNewSnippet] = useState({ name: '', content: '' });
  const [showSnippetForm, setShowSnippetForm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadProjects();
    }
  }, [isOpen]);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects);
      setActiveId(data.activeId);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  const createProject = async () => {
    if (!newProject.name) return;
    
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProject),
    });
    
    setNewProject({ name: '', description: '', rootPath: '', instructions: '' });
    setShowCreateForm(false);
    await loadProjects();
  };

  const deleteProject = async (id: string) => {
    if (!confirm('Delete this project?')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (selectedProject?.id === id) setSelectedProject(null);
    await loadProjects();
  };

  const activateProject = async (id: string) => {
    await fetch(`/api/projects/${id}/activate`, { method: 'POST' });
    await loadProjects();
  };

  const deactivateProject = async () => {
    await fetch('/api/projects/deactivate', { method: 'POST' });
    await loadProjects();
  };

  const addFile = async (projectId: string) => {
    if (!newFilePath) return;
    
    await fetch(`/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newFilePath, type: 'file' }),
    });
    
    setNewFilePath('');
    await loadProjects();
    
    // Refresh selected project
    const res = await fetch('/api/projects');
    const data = await res.json();
    const updated = data.projects.find((p: Project) => p.id === projectId);
    if (updated) setSelectedProject(updated);
  };

  const addSnippet = async (projectId: string) => {
    if (!newSnippet.name || !newSnippet.content) return;
    
    await fetch(`/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        type: 'snippet',
        name: newSnippet.name,
        content: newSnippet.content,
      }),
    });
    
    setNewSnippet({ name: '', content: '' });
    setShowSnippetForm(false);
    await loadProjects();
    
    const res = await fetch('/api/projects');
    const data = await res.json();
    const updated = data.projects.find((p: Project) => p.id === projectId);
    if (updated) setSelectedProject(updated);
  };

  const removeFile = async (projectId: string, filePath: string) => {
    await fetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    
    await loadProjects();
    
    const res = await fetch('/api/projects');
    const data = await res.json();
    const updated = data.projects.find((p: Project) => p.id === projectId);
    if (updated) setSelectedProject(updated);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end">
      <div className="w-[560px] bg-slate-800 h-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-5 h-5 text-blue-400" />
            <h2 className="font-semibold">Projects</h2>
            {activeId && (
              <span className="text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded-full">
                1 active
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : selectedProject ? (
            // Project detail view
            <div className="p-4 space-y-4">
              <button
                onClick={() => setSelectedProject(null)}
                className="text-sm text-slate-400 hover:text-white flex items-center gap-1"
              >
                ← Back to projects
              </button>

              <div className="space-y-2">
                <h3 className="font-semibold text-lg">{selectedProject.name}</h3>
                <p className="text-sm text-slate-400">{selectedProject.description}</p>
                
                {selectedProject.rootPath && (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <FolderOpen className="w-4 h-4" />
                    {selectedProject.rootPath}
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  {activeId === selectedProject.id ? (
                    <button
                      onClick={deactivateProject}
                      className="px-3 py-1.5 bg-slate-600 text-sm rounded hover:bg-slate-500"
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      onClick={() => activateProject(selectedProject.id)}
                      className="px-3 py-1.5 bg-blue-600 text-sm rounded hover:bg-blue-700"
                    >
                      Activate Project
                    </button>
                  )}
                  <button
                    onClick={() => deleteProject(selectedProject.id)}
                    className="px-3 py-1.5 bg-red-600/20 text-red-400 text-sm rounded hover:bg-red-600/30"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Instructions */}
              {selectedProject.instructions && (
                <div className="bg-slate-700/50 rounded-lg p-3">
                  <div className="text-xs text-slate-500 uppercase font-medium mb-1">Instructions</div>
                  <div className="text-sm text-slate-300 whitespace-pre-wrap">
                    {selectedProject.instructions}
                  </div>
                </div>
              )}

              {/* Files */}
              <div>
                <div className="text-sm font-medium mb-2">Context Files ({selectedProject.files.length})</div>
                
                {selectedProject.files.length > 0 ? (
                  <div className="space-y-2">
                    {selectedProject.files.map((file, i) => (
                      <div 
                        key={i}
                        className="flex items-center gap-2 bg-slate-700/50 rounded p-2"
                      >
                        {file.type === 'snippet' ? (
                          <FileText className="w-4 h-4 text-yellow-400" />
                        ) : (
                          <File className="w-4 h-4 text-slate-400" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{file.name}</div>
                          <div className="text-xs text-slate-500">
                            {(file.size / 1024).toFixed(1)} KB
                          </div>
                        </div>
                        <button
                          onClick={() => removeFile(selectedProject.id, file.path)}
                          className="text-slate-400 hover:text-red-400"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500 py-4 text-center">
                    No context files yet
                  </div>
                )}

                {/* Add file */}
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2">
                    <input
                      placeholder="File path (e.g., /path/to/file.ts)"
                      value={newFilePath}
                      onChange={(e) => setNewFilePath(e.target.value)}
                      className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm"
                    />
                    <button
                      onClick={() => addFile(selectedProject.id)}
                      disabled={!newFilePath}
                      className="px-3 py-2 bg-slate-600 text-sm rounded hover:bg-slate-500 disabled:opacity-50"
                    >
                      Add File
                    </button>
                  </div>

                  {showSnippetForm ? (
                    <div className="bg-slate-700/50 rounded p-3 space-y-2">
                      <input
                        placeholder="Snippet name"
                        value={newSnippet.name}
                        onChange={(e) => setNewSnippet(p => ({ ...p, name: e.target.value }))}
                        className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                      />
                      <textarea
                        placeholder="Snippet content"
                        value={newSnippet.content}
                        onChange={(e) => setNewSnippet(p => ({ ...p, content: e.target.value }))}
                        className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm h-24 resize-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => addSnippet(selectedProject.id)}
                          disabled={!newSnippet.name || !newSnippet.content}
                          className="px-3 py-1.5 bg-blue-600 text-sm rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          Add Snippet
                        </button>
                        <button
                          onClick={() => setShowSnippetForm(false)}
                          className="px-3 py-1.5 bg-slate-600 text-sm rounded hover:bg-slate-500"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowSnippetForm(true)}
                      className="text-sm text-slate-400 hover:text-white"
                    >
                      + Add text snippet
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            // Projects list view
            <div className="p-4 space-y-4">
              {/* Active project summary */}
              {activeId && (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
                  <div className="text-sm text-blue-300 font-medium mb-1">Active Project</div>
                  <div className="text-sm">
                    {projects.find(p => p.id === activeId)?.name}
                  </div>
                </div>
              )}

              {/* Projects list */}
              {projects.length > 0 ? (
                <div className="space-y-2">
                  {projects.map(project => (
                    <div 
                      key={project.id}
                      onClick={() => setSelectedProject(project)}
                      className={cn(
                        'bg-slate-700/50 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-slate-700',
                        activeId === project.id 
                          ? 'border-blue-500/50' 
                          : 'border-slate-600'
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {project.name}
                            {activeId === project.id && (
                              <Check className="w-4 h-4 text-blue-400" />
                            )}
                          </div>
                          <div className="text-sm text-slate-400">
                            {project.description}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {project.files.length} context files
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500">
                  <FolderKanban className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <div>No projects yet</div>
                  <div className="text-sm">Create a project to add context files</div>
                </div>
              )}

              {/* Create project form */}
              {showCreateForm ? (
                <div className="bg-slate-700/50 rounded-lg border border-slate-600 p-4 space-y-3">
                  <div className="font-medium text-sm">Create New Project</div>
                  
                  <input
                    placeholder="Project name"
                    value={newProject.name}
                    onChange={(e) => setNewProject(p => ({ ...p, name: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                  />
                  
                  <input
                    placeholder="Description (optional)"
                    value={newProject.description}
                    onChange={(e) => setNewProject(p => ({ ...p, description: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                  />
                  
                  <input
                    placeholder="Root path (optional, e.g., /path/to/project)"
                    value={newProject.rootPath}
                    onChange={(e) => setNewProject(p => ({ ...p, rootPath: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                  />
                  
                  <textarea
                    placeholder="Project instructions (optional)"
                    value={newProject.instructions}
                    onChange={(e) => setNewProject(p => ({ ...p, instructions: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm h-24 resize-none"
                  />
                  
                  <div className="flex gap-2">
                    <button
                      onClick={createProject}
                      disabled={!newProject.name}
                      className="px-3 py-1.5 bg-blue-600 text-sm rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => setShowCreateForm(false)}
                      className="px-3 py-1.5 bg-slate-600 text-sm rounded hover:bg-slate-500"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="w-full py-2 border border-dashed border-slate-600 rounded-lg text-sm text-slate-400 hover:border-slate-500 hover:text-slate-300 flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Create New Project
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
