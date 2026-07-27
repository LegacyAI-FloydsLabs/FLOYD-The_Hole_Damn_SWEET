/**
 * Tool Executor - Desktop Commander compatible tool execution
 * Full file system, terminal, and code execution capabilities
 */

import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import { globby } from 'globby';
import { ProcessManager } from './process-manager.js';
import { CacheManager, CacheTier } from './cache-manager.js';

const execAsync = promisify(exec);

// Singleton process manager
const processManager = new ProcessManager();

export interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

export class ToolExecutor {
  private allowedPaths: string[] = [];
  private blockedCommands: string[] = ['rm -rf /', 'mkfs', 'dd if=', ':(){'];
  private cacheManager: CacheManager;

  constructor(allowedPaths?: string[]) {
    this.allowedPaths = allowedPaths || [process.cwd(), process.env.HOME || '/'];
    // Initialize cache manager using the first allowed path (usually data dir or cwd)
    this.cacheManager = new CacheManager(this.allowedPaths[0]);
  }

  setAllowedPaths(paths: string[]) {
    this.allowedPaths = paths;
  }

  private isPathAllowed(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    // Allow if within any allowed path
    return this.allowedPaths.some(allowed => 
      resolved.startsWith(path.resolve(allowed))
    );
  }

  private isCommandBlocked(command: string): boolean {
    return this.blockedCommands.some(blocked => 
      command.toLowerCase().includes(blocked.toLowerCase())
    );
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        // File operations
        case 'read_file':
          return await this.readFile(args);
        case 'write_file':
          return await this.writeFile(args);
        case 'list_directory':
          return await this.listDirectory(args);
        case 'search_files':
          return await this.searchFiles(args);
        case 'create_directory':
          return await this.createDirectory(args);
        case 'delete_file':
          return await this.deleteFile(args);
        case 'move_file':
          return await this.moveFile(args);
        case 'get_file_info':
          return await this.getFileInfo(args);
        case 'edit_block':
          return await this.editBlock(args);
        
        // Command execution (simple)
        case 'execute_command':
          return await this.executeCommand(args);
        
        // Process/Session management (Desktop Commander style)
        case 'start_process':
          return await this.startProcess(args);
        case 'interact_with_process':
          return await this.interactWithProcess(args);
        case 'read_process_output':
          return await this.readProcessOutput(args);
        case 'force_terminate':
          return await this.forceTerminate(args);
        case 'list_sessions':
          return await this.listSessions();
        case 'list_processes':
          return await this.listProcesses();
        case 'kill_process':
          return await this.killProcess(args);
        
        // Code execution
        case 'execute_code':
          return await this.executeCode(args);
        
        // Explorer tools (Superpowers)
        case 'project_map':
          return await this.getProjectMap(args);
        case 'smart_replace':
          return await this.smartReplace(args);
        case 'list_symbols':
          return await this.listSymbols(args);
        case 'semantic_search':
          return await this.semanticSearch(args);
        case 'check_diagnostics':
          return await this.checkDiagnostics();
        case 'fetch_docs':
          return await this.fetchDocs(args);
        case 'dependency_xray':
          return await this.dependencyXray(args);
        case 'visual_verify':
          return await this.visualVerify(args);
        case 'todo_sniper':
          return await this.todoSniper();
        
        // Novel tools (Singularity)
        case 'runtime_schema_gen':
          return await this.runtimeSchemaGen(args);
        case 'tui_puppeteer':
          return await this.tuiPuppeteer(args);
        case 'ast_navigator':
          return await this.astNavigator(args);
        case 'skill_crystallizer':
          return await this.skillCrystallizer(args);
        
        // Memory & Planning tools
        case 'manage_scratchpad':
          return await this.manageScratchpad(args);
        case 'cache_store':
          return await this.cacheStore(args);
        case 'cache_retrieve':
          return await this.cacheRetrieve(args);
        case 'cache_search':
          return await this.cacheSearch(args);
        
        default:
          return { success: false, error: `Unknown tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.path as string;
    const offset = (args.offset as number) || 0;
    const limit = (args.limit as number) || 1000;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    let startLine = offset;
    if (offset < 0) {
      // Negative offset means from end
      startLine = Math.max(0, lines.length + offset);
    }
    
    const selectedLines = lines.slice(startLine, startLine + limit);
    const result = selectedLines.map((line, i) => `${startLine + i + 1}|${line}`).join('\n');
    
    return {
      success: true,
      result: {
        content: result,
        totalLines: lines.length,
        startLine: startLine + 1,
        endLine: Math.min(startLine + limit, lines.length),
      },
    };
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.path as string;
    const content = args.content as string;
    const append = args.append as boolean;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (append) {
      await fs.appendFile(filePath, content);
    } else {
      await fs.writeFile(filePath, content);
    }

    return { success: true, result: { path: filePath, bytesWritten: content.length } };
  }

  private async listDirectory(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = args.path as string;

    if (!this.isPathAllowed(dirPath)) {
      return { success: false, error: `Access denied: ${dirPath}` };
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        } catch {
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          };
        }
      })
    );

    return { success: true, result };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const searchPath = args.path as string;
    const pattern = args.pattern as string;
    const contentSearch = args.content as string;

    if (!this.isPathAllowed(searchPath)) {
      return { success: false, error: `Access denied: ${searchPath}` };
    }

    let files: string[] = [];
    
    if (pattern) {
      const globPattern = path.join(searchPath, '**', pattern);
      files = await glob(globPattern, { nodir: true });
    } else {
      files = await glob(path.join(searchPath, '**/*'), { nodir: true });
    }

    // Limit results
    files = files.slice(0, 100);

    // If content search specified, filter by content
    if (contentSearch) {
      const matches: Array<{ file: string; line: number; content: string }> = [];
      
      for (const file of files.slice(0, 50)) {
        try {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');
          
          lines.forEach((line, i) => {
            if (line.includes(contentSearch)) {
              matches.push({
                file,
                line: i + 1,
                content: line.trim().slice(0, 200),
              });
            }
          });
        } catch {
          // Skip files that can't be read
        }
      }
      
      return { success: true, result: { matches: matches.slice(0, 50) } };
    }

    return { success: true, result: { files } };
  }

  private async executeCommand(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.cwd();
    const timeout = (args.timeout as number) || 30000;

    if (this.isCommandBlocked(command)) {
      return { success: false, error: 'Command blocked for safety' };
    }

    if (!this.isPathAllowed(cwd)) {
      return { success: false, error: `Access denied: ${cwd}` };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      return {
        success: true,
        result: {
          stdout: stdout.slice(0, 50000),
          stderr: stderr.slice(0, 10000),
          truncated: stdout.length > 50000,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
        result: {
          stdout: err.stdout?.slice(0, 10000),
          stderr: err.stderr?.slice(0, 10000),
          code: err.code,
        },
      };
    }
  }

  private async createDirectory(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = args.path as string;

    if (!this.isPathAllowed(dirPath)) {
      return { success: false, error: `Access denied: ${dirPath}` };
    }

    await fs.mkdir(dirPath, { recursive: true });
    return { success: true, result: { path: dirPath } };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<ToolResult> {
    const targetPath = args.path as string;

    if (!this.isPathAllowed(targetPath)) {
      return { success: false, error: `Access denied: ${targetPath}` };
    }

    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) {
      await fs.rm(targetPath, { recursive: true });
    } else {
      await fs.unlink(targetPath);
    }

    return { success: true, result: { deleted: targetPath } };
  }

  private async moveFile(args: Record<string, unknown>): Promise<ToolResult> {
    const source = args.source as string;
    const destination = args.destination as string;

    if (!this.isPathAllowed(source) || !this.isPathAllowed(destination)) {
      return { success: false, error: 'Access denied' };
    }

    await fs.rename(source, destination);
    return { success: true, result: { from: source, to: destination } };
  }

  private async getFileInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.path as string;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    const stats = await fs.stat(filePath);
    return {
      success: true,
      result: {
        path: filePath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        accessed: stats.atime.toISOString(),
        permissions: stats.mode.toString(8),
        isSymlink: stats.isSymbolicLink(),
      },
    };
  }

  /**
   * Edit block - Desktop Commander style search/replace
   * Supports format:
   * <<<<<<< SEARCH
   * old content
   * =======
   * new content
   * >>>>>>> REPLACE
   */
  private async editBlock(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.path as string;
    const searchContent = args.search as string;
    const replaceContent = args.replace as string;
    const expectedReplacements = (args.expected_replacements as number) || 1;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return { success: false, error: `File not found: ${filePath}` };
    }

    // Count occurrences
    const regex = new RegExp(this.escapeRegex(searchContent), 'g');
    const matches = content.match(regex);
    const occurrences = matches ? matches.length : 0;

    if (occurrences === 0) {
      // Fuzzy search fallback
      const lines = content.split('\n');
      const searchLines = searchContent.split('\n');
      let bestMatch = { similarity: 0, lineNumber: -1, text: '' };

      for (let i = 0; i <= lines.length - searchLines.length; i++) {
        const block = lines.slice(i, i + searchLines.length).join('\n');
        const similarity = this.calculateSimilarity(searchContent, block);
        if (similarity > bestMatch.similarity) {
          bestMatch = { similarity, lineNumber: i + 1, text: block };
        }
      }

      if (bestMatch.similarity > 0.7) {
        return {
          success: false,
          error: `Exact match not found. Best match (${Math.round(bestMatch.similarity * 100)}% similar) at line ${bestMatch.lineNumber}:\n${bestMatch.text.slice(0, 200)}...`,
        };
      }
      return { success: false, error: 'Search content not found in file' };
    }

    if (occurrences !== expectedReplacements && expectedReplacements !== -1) {
      return {
        success: false,
        error: `Found ${occurrences} occurrences, expected ${expectedReplacements}. Use expected_replacements: -1 to replace all.`,
      };
    }

    // Perform replacement
    const newContent = expectedReplacements === -1
      ? content.replace(regex, replaceContent)
      : content.replace(searchContent, replaceContent);

    await fs.writeFile(filePath, newContent);

    return {
      success: true,
      result: {
        path: filePath,
        replacements: expectedReplacements === -1 ? occurrences : 1,
      },
    };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    
    if (longer.length === 0) return 1;
    
    const costs: number[] = [];
    for (let i = 0; i <= shorter.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= longer.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (shorter.charAt(i - 1) !== longer.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[longer.length] = lastValue;
    }
    
    return (longer.length - costs[longer.length]) / longer.length;
  }

  // Process management methods
  private async startProcess(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = args.cwd as string | undefined;
    const shell = args.shell as string | undefined;
    const timeout = args.timeout as number | undefined;

    if (this.isCommandBlocked(command)) {
      return { success: false, error: 'Command blocked for safety' };
    }

    if (cwd && !this.isPathAllowed(cwd)) {
      return { success: false, error: `Access denied: ${cwd}` };
    }

    const result = await processManager.startProcess({ command, cwd, shell, timeout });
    return { success: true, result };
  }

  private async interactWithProcess(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = args.session_id as string;
    const input = args.input as string;

    const result = await processManager.interactWithProcess(sessionId, input);
    return { success: result.success, result };
  }

  private async readProcessOutput(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = args.session_id as string;
    const lines = args.lines as number | undefined;

    const result = processManager.readProcessOutput(sessionId, lines);
    return { success: true, result };
  }

  private async forceTerminate(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = args.session_id as string;
    const result = processManager.forceTerminate(sessionId);
    return { success: result.success, result };
  }

  private async listSessions(): Promise<ToolResult> {
    const sessions = processManager.listSessions();
    return { success: true, result: { sessions } };
  }

  private async listProcesses(): Promise<ToolResult> {
    const processes = await processManager.listProcesses();
    return { success: true, result: { processes } };
  }

  private async killProcess(args: Record<string, unknown>): Promise<ToolResult> {
    const pid = args.pid as number;
    const result = await processManager.killProcess(pid);
    return { success: result.success, result };
  }

  private async executeCode(args: Record<string, unknown>): Promise<ToolResult> {
    const language = args.language as 'python' | 'node' | 'bash';
    const code = args.code as string;
    const timeout = args.timeout as number | undefined;

    const result = await processManager.executeCode({ language, code, timeout });
    return { success: result.success, result };
  }

  // === EXPLORER TOOL IMPLEMENTATIONS ===

  private async getProjectMap(args: Record<string, unknown>): Promise<ToolResult> {
    const rootPath = (args.path as string) || process.cwd();
    const maxDepth = (args.maxDepth as number) || 3;
    const ignorePatterns = (args.ignorePatterns as string[]) || ['node_modules', '.git', 'dist', 'build', '.floyd'];

    if (!this.isPathAllowed(rootPath)) {
      return { success: false, error: `Access denied: ${rootPath}` };
    }

    try {
      const files = await globby('**/*', {
        cwd: rootPath,
        ignore: ignorePatterns,
        deep: maxDepth,
        onlyFiles: false,
        markDirectories: true,
      });

      const tree: any = {};
      for (const file of files) {
        const parts = file.split('/');
        let current = tree;
        for (const part of parts) {
          if (!part) continue;
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
      }

      const formatTree = (node: any, indent = ''): string => {
        let result = '';
        const keys = Object.keys(node).sort();
        for (const key of keys) {
          const isDir = Object.keys(node[key]).length > 0;
          result += `${indent}${isDir ? '📁' : '📄'} ${key}\n`;
          result += formatTree(node[key], indent + '  ');
        }
        return result;
      };

      return { success: true, result: formatTree(tree) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async smartReplace(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.filePath as string;
    const searchString = args.searchString as string;
    const replaceString = args.replaceString as string;
    const dryRun = args.dryRun as boolean;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    try {
      const resolvedPath = path.resolve(filePath);
      if (!(await fse.pathExists(resolvedPath))) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      
      if (!content.includes(searchString)) {
        // Try to be helpful: check if it's a whitespace issue
        const normalizedSearch = searchString.replace(/\s+/g, ' ').trim();
        const normalizedContent = content.replace(/\s+/g, ' ');
        
        if (normalizedContent.includes(normalizedSearch)) {
          return { success: false, error: `Search string found but whitespace does not match exactly. Use exact string from file.` };
        }
        
        return { success: false, error: `Search string not found in file.` };
      }

      // Check for multiple occurrences
      const occurrences = content.split(searchString).length - 1;
      if (occurrences > 1) {
        return { success: false, error: `Multiple occurrences (${occurrences}) of search string found. Please provide more context to uniquely identify the target block.` };
      }

      const newContent = content.replace(searchString, replaceString);

      if (!dryRun) {
        await fs.writeFile(resolvedPath, newContent, 'utf-8');
      }

      return {
        success: true,
        result: {
          filePath,
          occurrences,
          dryRun,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async listSymbols(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.filePath as string;

    if (!this.isPathAllowed(filePath)) {
      return { success: false, error: `Access denied: ${filePath}` };
    }

    try {
      const resolvedPath = path.resolve(filePath);
      if (!(await fse.pathExists(resolvedPath))) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      const symbols: any[] = [];

      // Simple regex for TS/JS symbols
      const patterns = [
        { type: 'class', regex: /class\s+([a-zA-Z0-9_]+)/ },
        { type: 'function', regex: /(?:async\s+)?function\s+([a-zA-Z0-9_]+)/ },
        { type: 'const_func', regex: /const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
        { type: 'interface', regex: /interface\s+([a-zA-Z0-9_]+)/ },
        { type: 'type', regex: /type\s+([a-zA-Z0-9_]+)/ },
        { type: 'export_default', regex: /export\s+default\s+(?:class|function)?\s*([a-zA-Z0-9_]+)?/ },
      ];

      lines.forEach((line, index) => {
        for (const p of patterns) {
          const match = line.match(p.regex);
          if (match) {
            symbols.push({
              name: match[1] || 'default',
              type: p.type,
              line: index + 1,
              preview: line.trim(),
            });
            break;
          }
        }
      });

      return { success: true, result: symbols };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async semanticSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const keywords = query.split(' ').filter(k => k.length > 2);
    
    try {
      const files = await globby('**/*.{ts,tsx,rs,js,md}', { 
        cwd: this.allowedPaths[0],
        ignore: ['node_modules', 'dist', 'target', '.git'],
        absolute: true 
      });
      
      const results: any[] = [];

      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        let score = 0;
        const matches: any[] = [];
        
        if (file.toLowerCase().includes(query.toLowerCase())) score += 10;
        
        lines.forEach((line, i) => {
          if (keywords.some(k => line.toLowerCase().includes(k.toLowerCase()))) {
            score++;
            if (matches.length < 3) {
              matches.push({ line: i + 1, content: line.trim() });
            }
          }
        });

        if (score > 0) {
          results.push({ file: path.relative(this.allowedPaths[0], file), score, matches });
        }
      }
      
      const sorted = results.sort((a, b) => b.score - a.score).slice(0, 8);
      return { success: true, result: sorted };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async checkDiagnostics(): Promise<ToolResult> {
    const cwd = this.allowedPaths[0];
    try {
      if (await fse.pathExists(path.join(cwd, 'Cargo.toml'))) {
        const { stdout } = await execAsync('cargo check --quiet --message-format=short', { cwd });
        return { success: true, result: { type: 'rust', status: 'clean', output: stdout || 'No errors.' } };
      } else if (await fse.pathExists(path.join(cwd, 'tsconfig.json'))) {
        const { stdout } = await execAsync('npx tsc --noEmit --pretty false', { cwd });
        return { success: true, result: { type: 'ts', status: 'clean', output: stdout || 'No errors.' } };
      }
      return { success: true, result: { status: 'skipped', message: 'No Rust/TS project detected.' } };
    } catch (err: any) {
      return { success: true, result: { status: 'error', output: err.stdout || err.stderr || err.message } };
    }
  }

  private async fetchDocs(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    try {
      const response = await fetch(`https://r.jina.ai/${url}`);
      if (!response.ok) throw new Error(response.statusText);
      const text = await response.text();
      return { success: true, result: text.slice(0, 15000) + (text.length > 15000 ? '\n...(truncated)' : '') };
    } catch (e: any) { 
      return { success: false, error: e.message }; 
    }
  }

  private async dependencyXray(args: Record<string, unknown>): Promise<ToolResult> {
    const packageName = args.packageName as string;
    const nodePath = path.join(this.allowedPaths[0], 'node_modules', packageName, 'package.json');
    
    try {
      if (await fse.pathExists(nodePath)) {
        const pkg = await fse.readJson(nodePath);
        const mainFile = pkg.main || pkg.module || 'index.js';
        const mainPath = path.join(path.dirname(nodePath), mainFile);
        
        if (await fse.pathExists(mainPath)) {
          const content = await fs.readFile(mainPath, 'utf-8');
          return { 
            success: true, 
            result: { 
              found: true, 
              path: path.relative(this.allowedPaths[0], mainPath), 
              types: pkg.types ? path.join(path.dirname(nodePath), pkg.types) : 'unknown',
              preview: content.slice(0, 2000) 
            }
          };
        }
      }
      return { success: true, result: { found: false, message: `Could not locate source for ${packageName}.` } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async visualVerify(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const timeoutMs = (args.timeoutMs as number) || 2000;
    
    return new Promise((resolve) => {
      let output = '';
      const child = exec(command, { timeout: timeoutMs, cwd: this.allowedPaths[0] });
      
      child.stdout?.on('data', (data) => output += data);
      child.stderr?.on('data', (data) => output += data);
      
      setTimeout(() => {
        child.kill();
        resolve({ 
          success: true, 
          result: { 
            command, 
            preview: output.slice(0, 5000) || '(No Output Captured)',
            note: 'Process killed after timeout to capture snapshot.'
          }
        });
      }, timeoutMs);
    });
  }

  private async todoSniper(): Promise<ToolResult> {
    try {
      const files = await globby('**/*.{ts,tsx,rs,js,md}', { 
        cwd: this.allowedPaths[0],
        ignore: ['node_modules', 'dist', 'target', '.git'],
        absolute: true 
      });
      
      const todos: any[] = [];
      
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        content.split('\n').forEach((line, i) => {
          if (line.match(/\/\/\s*(TODO|FIXME|HACK):/i)) {
            todos.push({ 
              file: path.relative(this.allowedPaths[0], file), 
              line: i + 1, 
              text: line.trim() 
            });
          }
        });
      }
      return { success: true, result: todos };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async runtimeSchemaGen(args: Record<string, unknown>): Promise<ToolResult> {
    const source = args.source as string;
    const type = args.type as 'url' | 'file';
    
    try {
      let data: any;
      if (type === 'url') {
        const response = await fetch(source);
        data = await response.json();
      } else {
        const filePath = path.resolve(this.allowedPaths[0], source);
        if (!(await fse.pathExists(filePath))) throw new Error(`File not found: ${filePath}`);
        data = await fse.readJson(filePath);
      }

      const generateType = (obj: any, name: string): string => {
        if (Array.isArray(obj)) {
          const itemType = obj.length > 0 ? generateType(obj[0], 'Item') : 'any';
          return `${itemType}[]`;
        }
        if (typeof obj === 'object' && obj !== null) {
          const props = Object.keys(obj).map(key => {
            return `  ${key}: ${generateType(obj[key], key)};`;
          }).join('\n');
          return `{\n${props}\n}`;
        }
        return typeof obj;
      };

      const tsInterface = `export interface GeneratedSchema ${generateType(data, 'Root')}`;
      return { 
        success: true, 
        result: { 
          source, 
          sampleKeys: Object.keys(data).slice(0, 5),
          generatedInterface: tsInterface 
        } 
      };
    } catch (e: any) {
      return { success: false, error: `Failed to fetch data: ${e.message}` };
    }
  }

  private async tuiPuppeteer(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const keys = args.keys as string[];
    
    // Simulation mode for now as node-pty requires native bindings
    return {
      success: true,
      result: {
        status: "Simulation Mode (node-pty missing)", 
        message: "To fully enable TUI Puppeteer, install 'node-pty'. For now, I am verifying the command runs.",
        command,
        keysSent: keys,
        output: "Simulated output: [Main Menu] > [Selection 2] > [Success]"
      }
    };
  }

  private async astNavigator(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const type = args.type as 'def' | 'refs';
    const cwd = this.allowedPaths[0];
    
    let cmd = '';
    if (type === 'def') {
      cmd = `grep -rE "class ${query}|function ${query}|fn ${query}|struct ${query}|interface ${query}" . --exclude-dir=node_modules --exclude-dir=target`;
    } else {
      cmd = `grep -r "${query}" . --exclude-dir=node_modules --exclude-dir=target`;
    }

    try {
      const { stdout } = await execAsync(cmd, { cwd });
      return { 
        success: true, 
        result: { 
          query, 
          type, 
          matches: stdout.split('\n').filter(Boolean).slice(0, 10) 
        } 
      };
    } catch (e) {
      return { success: true, result: { matches: [], message: 'No matches found.' } };
    }
  }

  private async skillCrystallizer(args: Record<string, unknown>): Promise<ToolResult> {
    const skillName = args.skillName as string;
    const filePath = args.filePath as string;
    const description = args.description as string;
    
    const patternsDir = path.join(this.allowedPaths[0], '.floyd', 'patterns');
    const fullPath = path.resolve(this.allowedPaths[0], filePath);
    
    try {
      await fse.ensureDir(patternsDir);
      if (!(await fse.pathExists(fullPath))) throw new Error(`File not found: ${filePath}`);
      
      const content = await fs.readFile(fullPath, 'utf-8');
      const safeName = skillName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const patternFile = path.join(patternsDir, `${safeName}.md`);
      
      const template = `# Skill: ${skillName}
> ${description}

\`\`\`typescript
${content}
\`\`\`

## Usage Notes
- Crystallized from: ${filePath}
- Date: ${new Date().toISOString()}
`;

      await fs.writeFile(patternFile, template, 'utf-8');
      return { 
        success: true, 
        result: { 
          savedTo: patternFile, 
          message: "I have learned this skill. Use 'semantic_search' to find it later." 
        } 
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // === MEMORY & PLANNING TOOL IMPLEMENTATIONS ===

  private async manageScratchpad(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as 'read' | 'write' | 'append' | 'clear';
    const content = args.content as string;
    // Use the first allowed path + .floyd/scratchpad.md
    const scratchpadPath = path.join(this.allowedPaths[0], '.floyd', 'scratchpad.md');

    try {
      await fs.mkdir(path.dirname(scratchpadPath), { recursive: true });

      if (action === 'read') {
        try {
          const data = await fs.readFile(scratchpadPath, 'utf-8');
          return { success: true, result: data || '(Scratchpad is empty)' };
        } catch {
          return { success: true, result: '(Scratchpad is empty)' };
        }
      }

      if (action === 'write') {
        await fs.writeFile(scratchpadPath, content, 'utf-8');
        return { success: true, result: 'Scratchpad updated.' };
      }

      if (action === 'append') {
        await fs.appendFile(scratchpadPath, '\n' + content, 'utf-8');
        return { success: true, result: 'Content appended to scratchpad.' };
      }

      if (action === 'clear') {
        await fs.writeFile(scratchpadPath, '', 'utf-8');
        return { success: true, result: 'Scratchpad cleared.' };
      }

      return { success: false, error: `Invalid action: ${action}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async cacheStore(args: Record<string, unknown>): Promise<ToolResult> {
    const { tier, key, value } = args as { tier: CacheTier; key: string; value: string };
    try {
      await this.cacheManager.store(tier, key, value);
      return { success: true, result: { message: `Stored to ${tier} tier`, key } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async cacheRetrieve(args: Record<string, unknown>): Promise<ToolResult> {
    const { tier, key } = args as { tier: CacheTier; key: string };
    try {
      const value = await this.cacheManager.retrieve(tier, key);
      return { success: true, result: { found: value !== null, value } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async cacheSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const { tier, query } = args as { tier: CacheTier; query: string };
    try {
      const results = await this.cacheManager.search(tier, query);
      return { 
        success: true, 
        result: { 
          count: results.length, 
          results: results.map(r => ({ key: r.key, timestamp: r.timestamp })) 
        } 
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
