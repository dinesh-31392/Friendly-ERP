import { useState, useEffect, useMemo } from 'react';
import { X, Search, MessageCircle } from 'lucide-react';
import { apiGetLeads } from '../services/apiClient';
import type { Lead } from '../types';

/**
 * Lead picker for starting a WhatsApp conversation that has no history yet.
 * Only leads with a phone number are offered — there is nothing to message
 * otherwise — and the list is searchable by name, number and project.
 */
export default function NewChatPicker({ onPick, onClose }: {
  onPick: (lead: Lead) => void;
  onClose: () => void;
}) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiGetLeads()
      .then(rows => setLeads(rows.filter(l => (l.phone ?? '').replace(/\D/g, '').length >= 8)))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load leads'));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = leads ?? [];
    if (!q) return rows.slice(0, 100);
    return rows.filter(l =>
      l.name.toLowerCase().includes(q) ||
      (l.phone ?? '').replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
      (l.project ?? '').toLowerCase().includes(q)
    ).slice(0, 100);
  }, [leads, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label="Start a new chat">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100">
          <MessageCircle className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-semibold text-zinc-900 flex-1">Start a new chat</p>
          <button onClick={onClose} className="p-1.5 hover:bg-zinc-100 rounded-lg" aria-label="Close">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="p-3 border-b border-zinc-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              autoFocus value={search} onChange={e => setSearch(e.target.value)}
              // Chrome autofills bare text inputs with a saved phone number,
              // which silently filtered the list down to nothing on open.
              autoComplete="off" name="lead-search" type="search"
              placeholder="Search leads by name, number or project"
              className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="text-sm text-red-500 p-4 text-center">{error}</p>}
          {!error && leads === null && <p className="text-sm text-zinc-400 p-6 text-center">Loading leads…</p>}
          {leads !== null && filtered.length === 0 && (
            <p className="text-sm text-zinc-400 p-6 text-center">
              {leads.length === 0 ? 'No leads have a phone number yet.' : `No leads match “${search}”.`}
            </p>
          )}
          {filtered.map(l => (
            <button
              key={l.id}
              onClick={() => onPick(l)}
              className="w-full text-left px-4 py-3 border-b border-zinc-50 hover:bg-emerald-50/50 flex items-center gap-3"
            >
              <div className="h-9 w-9 shrink-0 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-sm font-semibold">
                {l.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-800 truncate">{l.name}</p>
                <p className="text-xs text-zinc-500 truncate">{l.phone}{l.project ? ` · ${l.project}` : ''}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
