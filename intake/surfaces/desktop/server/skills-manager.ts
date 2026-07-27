/**
 * Skills Manager - Like Claude Desktop's Skills feature
 * Skills are reusable instruction sets that modify Claude's behavior
 */

import fs from 'fs/promises';
import path from 'path';

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  triggers?: string[];  // Auto-activate on these keywords
  enabled: boolean;
  category: 'coding' | 'writing' | 'analysis' | 'automation' | 'custom';
  icon?: string;
}

const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Thorough code review with security, performance, and best practices analysis',
    instructions: `When reviewing code:
1. Check for security vulnerabilities (injection, XSS, auth issues)
2. Identify performance bottlenecks and memory leaks
3. Evaluate error handling and edge cases
4. Assess code readability and maintainability
5. Suggest specific improvements with examples
6. Consider test coverage requirements`,
    triggers: ['review', 'code review', 'check my code'],
    enabled: true,
    category: 'coding',
    icon: '🔍',
  },
  {
    id: 'refactor',
    name: 'Refactoring Assistant',
    description: 'Help refactor code with best practices and design patterns',
    instructions: `When refactoring:
1. Identify code smells and anti-patterns
2. Apply SOLID principles where appropriate
3. Extract reusable functions and components
4. Improve naming and code organization
5. Maintain backward compatibility
6. Write comprehensive tests for changes`,
    triggers: ['refactor', 'clean up', 'improve code'],
    enabled: true,
    category: 'coding',
    icon: '🔧',
  },
  {
    id: 'debugging',
    name: 'Debug Detective',
    description: 'Systematic debugging approach to find and fix issues',
    instructions: `When debugging:
1. Reproduce the issue consistently
2. Gather error messages, logs, and stack traces
3. Identify the root cause, not just symptoms
4. Form hypotheses and test them methodically
5. Explain the fix and why it works
6. Suggest preventive measures`,
    triggers: ['debug', 'fix bug', 'error', 'not working'],
    enabled: true,
    category: 'coding',
    icon: '🐛',
  },
  {
    id: 'documentation',
    name: 'Documentation Writer',
    description: 'Create clear, comprehensive documentation',
    instructions: `When writing documentation:
1. Start with a clear overview/summary
2. Include installation and setup instructions
3. Provide usage examples with code
4. Document all parameters and return values
5. Include troubleshooting section
6. Keep it concise but complete`,
    triggers: ['document', 'write docs', 'readme'],
    enabled: true,
    category: 'writing',
    icon: '📝',
  },
  {
    id: 'testing',
    name: 'Test Engineer',
    description: 'Write comprehensive tests with good coverage',
    instructions: `When writing tests:
1. Cover happy path and edge cases
2. Use descriptive test names that explain intent
3. Follow Arrange-Act-Assert pattern
4. Mock external dependencies appropriately
5. Aim for meaningful coverage, not just numbers
6. Include integration tests where needed`,
    triggers: ['test', 'write tests', 'unit test'],
    enabled: true,
    category: 'coding',
    icon: '🧪',
  },
  {
    id: 'security-audit',
    name: 'Security Auditor',
    description: 'Identify security vulnerabilities and suggest fixes',
    instructions: `When auditing security:
1. Check for OWASP Top 10 vulnerabilities
2. Review authentication and authorization
3. Examine input validation and sanitization
4. Check for sensitive data exposure
5. Review dependency vulnerabilities
6. Suggest security improvements with priority`,
    triggers: ['security', 'audit', 'vulnerabilities'],
    enabled: true,
    category: 'analysis',
    icon: '🔒',
  },
  {
    id: 'performance',
    name: 'Performance Optimizer',
    description: 'Analyze and improve performance',
    instructions: `When optimizing performance:
1. Profile to identify actual bottlenecks
2. Measure before and after changes
3. Consider memory vs CPU tradeoffs
4. Optimize database queries and indexes
5. Implement caching where appropriate
6. Consider lazy loading and code splitting`,
    triggers: ['performance', 'optimize', 'slow', 'speed up'],
    enabled: true,
    category: 'analysis',
    icon: '⚡',
  },
  {
    id: 'explain',
    name: 'Code Explainer',
    description: 'Explain code clearly for different skill levels',
    instructions: `When explaining code:
1. Start with high-level overview
2. Break down complex logic step by step
3. Explain the "why" not just the "what"
4. Use analogies for difficult concepts
5. Highlight important patterns and idioms
6. Adjust detail level to audience`,
    triggers: ['explain', 'what does this do', 'how does this work'],
    enabled: true,
    category: 'analysis',
    icon: '💡',
  },
  {
    id: 'doc-parity',
    name: 'Documentation Parity',
    description: 'Validates that code and documentation stay synchronized using real static analysis',
    instructions: `When validating documentation parity:
1. Use the 'project_map' tool to understand the codebase structure.
2. Use 'list_symbols' to extract exported symbols from source files.
3. Compare extracted symbols and signatures against the documentation.
4. Report mismatches with severity levels (Critical, Warning, Info).
5. Suggest auto-fixes where applicable (e.g., updating placeholders or removing orphaned entries).`,
    triggers: ['validate docs', 'check documentation', 'doc parity', 'documentation drift'],
    enabled: true,
    category: 'coding',
    icon: '📊',
  },
  {
    id: 'ssot-validation',
    name: 'SSOT Validation',
    description: 'Validates Single Source of Truth (SSOT) files against actual code implementation',
    instructions: `When performing SSOT validation:
1. Identify SSOT files (e.g., *SSOT*.md, *ARCHITECTURE*.md, CLAUDE.md).
2. Verify all file references and paths in the SSOT exist using 'list_directory' or 'get_file_info'.
3. Use 'list_symbols' to confirm mentioned exports are actually present in the referenced files.
4. Report any drift between the SSOT and reality.`,
    triggers: ['ssot', 'architecture docs', 'truth sources'],
    enabled: true,
    category: 'analysis',
    icon: '🎯',
  },
  {
    id: 'explorer-superpowers',
    name: 'Explorer (Spatial Awareness)',
    description: 'High-level codebase navigation, structural analysis, and surgical editing',
    instructions: `You have advanced "spatial awareness" superpowers:
1. Use 'project_map' to get an instant mental map of the codebase without manual exploration.
2. Use 'list_symbols' to understand a file's structure (classes, functions) before reading it.
3. Use 'smart_replace' for robust surgical edits that don't rely on brittle context lines.
4. Favor these high-level tools over granular file operations when analyzing project structure.`,
    triggers: ['spatial awareness', 'codebase map', 'mental map', 'surgical edit'],
    enabled: true,
    category: 'automation',
    icon: '🚀',
  },
  {
    id: 'supercache',
    name: 'Supercache (3-Tier Memory)',
    description: 'Persistent knowledge and reasoning storage across turns',
    instructions: `You have a 3-tier memory system to persist knowledge:
1. TIER 1: 'reasoning' (Short-term) - Store complex multi-step reasoning or temporary variables.
2. TIER 2: 'project' (Medium-term) - Store project-specific facts, architectural decisions, or build instructions.
3. TIER 3: 'vault' (Long-term) - Store reusable wisdom, complex regex patterns, or specialized snippets.
Always check 'cache_search' before repeating complex analysis.`,
    triggers: ['cache', 'remember this', 'persist reasoning', 'save to vault'],
    enabled: true,
    category: 'automation',
    icon: '⚡',
  },
  {
    id: 'singularity-mode',
    name: 'Singularity Mode (Self-Learning)',
    description: 'Tier 4 protocols for active learning, truth seeking, and ghost testing',
    instructions: `STANDARD OPERATIONS PROTOCOL (SINGULARITY MODE):
1. 🧠 ACTIVE LEARNING: When you solve a hard problem, use 'skill_crystallizer' to save the pattern. Check patterns before starting new tasks.
2. 👁️ GHOST TESTING: Use 'tui_puppeteer' to simulate user interactions and 'visual_verify' for snapshots.
3. 🔬 TRUTH SEEKING: Don't guess APIs. Use 'runtime_schema_gen' to generate TypeScript interfaces from live data.
4. 🧭 BRAIN SURGERY: Use 'ast_navigator' for precise definition/reference finding.`,
    triggers: ['singularity', 'learn this', 'crystallize', 'schema gen'],
    enabled: true,
    category: 'automation',
    icon: '🔮',
  },
];

export class SkillsManager {
  private skills: Map<string, Skill> = new Map();
  private dataPath: string;
  private activeSkills: Set<string> = new Set();

  constructor(dataDir: string) {
    this.dataPath = path.join(dataDir, 'skills.json');
  }

  async init(): Promise<void> {
    // Load saved skills or use defaults
    try {
      const data = await fs.readFile(this.dataPath, 'utf-8');
      const saved = JSON.parse(data) as { skills: Skill[]; active: string[] };
      saved.skills.forEach(s => this.skills.set(s.id, s));
      saved.active.forEach(id => this.activeSkills.add(id));
    } catch {
      // Use defaults
      DEFAULT_SKILLS.forEach(s => this.skills.set(s.id, s));
    }
  }

  async save(): Promise<void> {
    const data = {
      skills: Array.from(this.skills.values()),
      active: Array.from(this.activeSkills),
    };
    await fs.writeFile(this.dataPath, JSON.stringify(data, null, 2));
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  async create(skill: Omit<Skill, 'id'>): Promise<Skill> {
    const id = `custom_${Date.now()}`;
    const newSkill: Skill = { ...skill, id };
    this.skills.set(id, newSkill);
    await this.save();
    return newSkill;
  }

  async update(id: string, updates: Partial<Skill>): Promise<Skill | null> {
    const skill = this.skills.get(id);
    if (!skill) return null;
    
    const updated = { ...skill, ...updates, id };
    this.skills.set(id, updated);
    await this.save();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.skills.delete(id);
    this.activeSkills.delete(id);
    if (deleted) await this.save();
    return deleted;
  }

  async activate(id: string): Promise<boolean> {
    if (!this.skills.has(id)) return false;
    this.activeSkills.add(id);
    await this.save();
    return true;
  }

  async deactivate(id: string): Promise<boolean> {
    if (!this.skills.has(id)) return false;
    this.activeSkills.delete(id);
    await this.save();
    return true;
  }

  isActive(id: string): boolean {
    return this.activeSkills.has(id);
  }

  getActiveSkills(): Skill[] {
    return Array.from(this.activeSkills)
      .map(id => this.skills.get(id))
      .filter((s): s is Skill => s !== undefined);
  }

  /**
   * Get combined system prompt from all active skills
   */
  getSystemPromptAdditions(): string {
    const active = this.getActiveSkills();
    if (active.length === 0) return '';

    const additions = active.map(skill => 
      `## ${skill.name}\n${skill.instructions}`
    ).join('\n\n');

    return `\n\n---\n\n# Active Skills\n\n${additions}`;
  }

  /**
   * Auto-detect skills based on message content
   */
  detectSkillsFromMessage(message: string): Skill[] {
    const lower = message.toLowerCase();
    const detected: Skill[] = [];

    for (const skill of this.skills.values()) {
      if (!skill.triggers || !skill.enabled) continue;
      
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          detected.push(skill);
          break;
        }
      }
    }

    return detected;
  }
}
