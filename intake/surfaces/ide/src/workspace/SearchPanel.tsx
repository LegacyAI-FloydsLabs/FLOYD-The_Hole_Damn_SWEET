import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/Icon';
import { useWorkspace } from './WorkspaceProvider';
import { useEditorStore } from '@/store/editorStore';
import { useUIStore } from '@/store/uiStore';
import type { WorkspaceSearchResult } from './FileSystemService';

export function SearchPanel() {
  const { fs, workspaceRoot } = useWorkspace();
  const openTab = useEditorStore((state) => state.openTab);
  const addToast = useUIStore((state) => state.addToast);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    try {
      const next = await fs.searchWorkspace(query);
      setResults(next);
      setHasSearched(true);
      if (next.length === 200) addToast('Search stopped at the 200-result safety limit.', 'warning');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Workspace search failed.', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="search-panel" aria-label="Workspace search">
      <header className="panel-title-row"><span>SEARCH</span><small>{results.length > 0 ? results.length : ''}</small></header>
      <form className="search-form" onSubmit={runSearch}>
        <div className="input-with-icon"><Icon name="search" size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" aria-label="Search workspace files" autoFocus /></div>
        <button className="button primary compact-button" type="submit" disabled={!query.trim() || loading}>{loading ? 'Searching' : 'Search'}</button>
      </form>
      <p className="panel-caption">{workspaceRoot || 'No workspace connected'}</p>
      <div className="search-results">
        {results.map((result, index) => (
          <button className="search-result" key={`${result.path}:${result.line}:${index}`} onClick={() => openTab(result.path)}>
            <span className="search-result-title"><strong>{result.path.split('/').pop()}</strong><small>Ln {result.line}, Col {result.column}</small></span>
            <span className="search-result-path">{result.path}</span>
            <code>{result.preview}</code>
          </button>
        ))}
        {hasSearched && !loading && results.length === 0 && <div className="panel-empty"><Icon name="search" /><strong>No matches</strong><span>Try a different term.</span></div>}
      </div>
    </section>
  );
}
