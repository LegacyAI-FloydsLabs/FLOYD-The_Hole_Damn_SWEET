/**
 * Projects Manager - Like Claude Desktop's Projects feature
 * Projects contain context files that are automatically included in conversations
 */

import fs from 'fs/promises';
import path from 'path';

export interface ProjectFile {
  path: string;
  name: string;
  content?: string;  // Cached content
  size: number;
  type: 'file' | 'url' | 'snippet';
  lastModified: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  rootPath?: string;  // Local project root
  files: ProjectFile[];
  instructions?: string;  // Project-specific instructions
  created: number;
  updated: number;
}

export class ProjectsManager {
  private projects: Map<string, Project> = new Map();
  private dataPath: string;
  private activeProjectId: string | null = null;
  private maxFileSize = 100 * 1024;  // 100KB max per file
  private maxTotalSize = 500 * 1024;  // 500KB total context

  constructor(dataDir: string) {
    this.dataPath = path.join(dataDir, 'projects.json');
  }

  async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.dataPath, 'utf-8');
      const saved = JSON.parse(data) as { projects: Project[]; active: string | null };
      saved.projects.forEach(p => this.projects.set(p.id, p));
      this.activeProjectId = saved.active;
    } catch {
      // No saved projects
    }
  }

  async save(): Promise<void> {
    const data = {
      projects: Array.from(this.projects.values()),
      active: this.activeProjectId,
    };
    await fs.writeFile(this.dataPath, JSON.stringify(data, null, 2));
  }

  getAll(): Project[] {
    return Array.from(this.projects.values());
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  getActive(): Project | null {
    if (!this.activeProjectId) return null;
    return this.projects.get(this.activeProjectId) || null;
  }

  async create(data: { name: string; description: string; rootPath?: string; instructions?: string }): Promise<Project> {
    const id = `project_${Date.now()}`;
    const project: Project = {
      id,
      name: data.name,
      description: data.description,
      rootPath: data.rootPath,
      instructions: data.instructions,
      files: [],
      created: Date.now(),
      updated: Date.now(),
    };
    this.projects.set(id, project);
    await this.save();
    return project;
  }

  async update(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'rootPath' | 'instructions'>>): Promise<Project | null> {
    const project = this.projects.get(id);
    if (!project) return null;

    Object.assign(project, updates, { updated: Date.now() });
    await this.save();
    return project;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.projects.delete(id);
    if (this.activeProjectId === id) {
      this.activeProjectId = null;
    }
    if (deleted) await this.save();
    return deleted;
  }

  async setActive(id: string | null): Promise<void> {
    this.activeProjectId = id;
    await this.save();
  }

  async addFile(projectId: string, filePath: string): Promise<ProjectFile | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;

    // Check if already added
    if (project.files.some(f => f.path === filePath)) {
      return null;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.size > this.maxFileSize) {
        throw new Error(`File too large: ${stats.size} bytes (max ${this.maxFileSize})`);
      }

      const content = await fs.readFile(filePath, 'utf-8');
      
      const file: ProjectFile = {
        path: filePath,
        name: path.basename(filePath),
        content,
        size: stats.size,
        type: 'file',
        lastModified: stats.mtimeMs,
      };

      project.files.push(file);
      project.updated = Date.now();
      await this.save();
      return file;
    } catch (err: any) {
      console.error(`Failed to add file: ${err.message}`);
      return null;
    }
  }

  async addSnippet(projectId: string, name: string, content: string): Promise<ProjectFile | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const file: ProjectFile = {
      path: `snippet:${name}`,
      name,
      content,
      size: content.length,
      type: 'snippet',
      lastModified: Date.now(),
    };

    project.files.push(file);
    project.updated = Date.now();
    await this.save();
    return file;
  }

  async removeFile(projectId: string, filePath: string): Promise<boolean> {
    const project = this.projects.get(projectId);
    if (!project) return false;

    const idx = project.files.findIndex(f => f.path === filePath);
    if (idx === -1) return false;

    project.files.splice(idx, 1);
    project.updated = Date.now();
    await this.save();
    return true;
  }

  async refreshFileContents(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) return;

    for (const file of project.files) {
      if (file.type !== 'file') continue;
      
      try {
        const stats = await fs.stat(file.path);
        if (stats.mtimeMs !== file.lastModified) {
          const content = await fs.readFile(file.path, 'utf-8');
          file.content = content;
          file.size = stats.size;
          file.lastModified = stats.mtimeMs;
        }
      } catch {
        // File may have been deleted
        file.content = '[FILE NOT FOUND]';
      }
    }

    await this.save();
  }

  /**
   * Get context string for active project
   */
  async getProjectContext(): Promise<string> {
    const project = this.getActive();
    if (!project) return '';

    await this.refreshFileContents(project.id);

    let context = `\n\n---\n\n# Project: ${project.name}\n`;
    
    if (project.description) {
      context += `\n${project.description}\n`;
    }

    if (project.rootPath) {
      context += `\nProject root: ${project.rootPath}\n`;
    }

    if (project.instructions) {
      context += `\n## Instructions\n${project.instructions}\n`;
    }

    if (project.files.length > 0) {
      context += `\n## Context Files\n`;
      
      let totalSize = 0;
      for (const file of project.files) {
        if (totalSize + file.size > this.maxTotalSize) {
          context += `\n[Additional files truncated due to size limit]\n`;
          break;
        }

        context += `\n### ${file.name}\n`;
        context += '```\n';
        context += file.content || '[No content]';
        context += '\n```\n';
        
        totalSize += file.size;
      }
    }

    return context;
  }
}
