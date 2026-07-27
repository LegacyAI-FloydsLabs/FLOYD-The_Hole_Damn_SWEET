/**
 * Skills Panel - Manage and activate skills
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { 
  Sparkles, 
  Check, 
  Plus, 
  Trash2, 
  ChevronDown,
  ChevronRight,
  Loader2
} from 'lucide-react';

interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  triggers?: string[];
  enabled: boolean;
  category: string;
  icon?: string;
  isActive?: boolean;
}

interface SkillsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SkillsPanel({ isOpen, onClose }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [togglingSkills, setTogglingSkills] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newSkill, setNewSkill] = useState({
    name: '',
    description: '',
    instructions: '',
    category: 'custom' as const,
  });

  // Load skills
  useEffect(() => {
    if (isOpen) {
      loadSkills();
    }
  }, [isOpen]);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) throw new Error(`Unable to load skills (HTTP ${res.status})`);
      const data = await res.json();
      setSkills(data.skills);
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSkill = async (skill: Skill) => {
    const endpoint = skill.isActive 
      ? `/api/skills/${skill.id}/deactivate`
      : `/api/skills/${skill.id}/activate`;

    setToggleError(null);
    setTogglingSkills(current => new Set(current).add(skill.id));
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const isActive = typeof data.isActive === 'boolean'
        ? data.isActive
        : !skill.isActive;
      setSkills(current => current.map(item =>
        item.id === skill.id ? { ...item, isActive } : item
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setToggleError(`Could not update ${skill.name}: ${message}`);
    } finally {
      setTogglingSkills(current => {
        const next = new Set(current);
        next.delete(skill.id);
        return next;
      });
    }
  };

  const deleteSkill = async (id: string) => {
    if (!confirm('Delete this skill?')) return;
    await fetch(`/api/skills/${id}`, { method: 'DELETE' });
    await loadSkills();
  };

  const createSkill = async () => {
    if (!newSkill.name || !newSkill.instructions) return;
    
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newSkill,
        enabled: true,
        triggers: [],
      }),
    });
    
    setNewSkill({ name: '', description: '', instructions: '', category: 'custom' });
    setShowCreateForm(false);
    await loadSkills();
  };

  if (!isOpen) return null;

  const activeSkills = skills.filter(s => s.isActive);
  const categories = [...new Set(skills.map(s => s.category))];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end">
      <div className="w-[480px] bg-slate-800 h-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <h2 className="font-semibold">Skills</h2>
            {activeSkills.length > 0 && (
              <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full">
                {activeSkills.length} active
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {toggleError && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
            >
              {toggleError}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <>
              {/* Active skills summary */}
              {activeSkills.length > 0 && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
                  <div className="text-sm text-purple-300 font-medium mb-2">Active Skills</div>
                  <div className="flex flex-wrap gap-2">
                    {activeSkills.map(skill => (
                      <span 
                        key={skill.id}
                        className="text-xs bg-purple-500/30 text-purple-200 px-2 py-1 rounded"
                      >
                        {skill.icon || '✨'} {skill.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills by category */}
              {categories.map(category => (
                <div key={category}>
                  <div className="text-xs uppercase text-slate-500 font-medium mb-2">
                    {category}
                  </div>
                  <div className="space-y-2">
                    {skills.filter(s => s.category === category).map(skill => (
                      <div 
                        key={skill.id}
                        className={cn(
                          'bg-slate-700/50 rounded-lg border transition-colors',
                          skill.isActive 
                            ? 'border-purple-500/50 bg-purple-500/10' 
                            : 'border-slate-600'
                        )}
                      >
                        <div 
                          className="flex items-center gap-3 p-3 cursor-pointer"
                          onClick={() => setExpandedSkill(
                            expandedSkill === skill.id ? null : skill.id
                          )}
                        >
                          <span className="text-xl">{skill.icon || '✨'}</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm">{skill.name}</div>
                            <div className="text-xs text-slate-400 truncate">
                              {skill.description}
                            </div>
                          </div>
                          
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleSkill(skill);
                            }}
                            disabled={togglingSkills.has(skill.id)}
                            aria-label={`${skill.isActive ? 'Disable' : 'Enable'} ${skill.name}`}
                            aria-pressed={Boolean(skill.isActive)}
                            aria-busy={togglingSkills.has(skill.id)}
                            className={cn(
                              'w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-60 disabled:cursor-wait',
                              skill.isActive 
                                ? 'bg-purple-500 text-white' 
                                : 'bg-slate-600 text-slate-400 hover:bg-slate-500'
                            )}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          
                          {expandedSkill === skill.id ? (
                            <ChevronDown className="w-4 h-4 text-slate-400" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-slate-400" />
                          )}
                        </div>
                        
                        {expandedSkill === skill.id && (
                          <div className="px-3 pb-3 border-t border-slate-600/50 mt-2 pt-2">
                            <div className="text-xs text-slate-400 whitespace-pre-wrap">
                              {skill.instructions}
                            </div>
                            {skill.triggers && skill.triggers.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-slate-500">Triggers: </span>
                                {skill.triggers.map((t, i) => (
                                  <span key={i} className="text-xs bg-slate-600 px-1.5 py-0.5 rounded mr-1">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                            {skill.category === 'custom' && (
                              <button
                                onClick={() => deleteSkill(skill.id)}
                                className="mt-2 text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete skill
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Create new skill */}
              {showCreateForm ? (
                <div className="bg-slate-700/50 rounded-lg border border-slate-600 p-4 space-y-3">
                  <div className="font-medium text-sm">Create New Skill</div>
                  
                  <input
                    placeholder="Skill name"
                    value={newSkill.name}
                    onChange={(e) => setNewSkill(p => ({ ...p, name: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                  />
                  
                  <input
                    placeholder="Description"
                    value={newSkill.description}
                    onChange={(e) => setNewSkill(p => ({ ...p, description: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm"
                  />
                  
                  <textarea
                    placeholder="Instructions (what Claude should do when this skill is active)"
                    value={newSkill.instructions}
                    onChange={(e) => setNewSkill(p => ({ ...p, instructions: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm h-32 resize-none"
                  />
                  
                  <div className="flex gap-2">
                    <button
                      onClick={createSkill}
                      disabled={!newSkill.name || !newSkill.instructions}
                      className="px-3 py-1.5 bg-purple-600 text-sm rounded hover:bg-purple-700 disabled:opacity-50"
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
                  Create Custom Skill
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
