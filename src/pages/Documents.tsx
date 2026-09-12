import { useState, useMemo, useEffect, useRef } from 'react';
import { FileText, Search, Plus, Download, Eye, Trash2, Filter, Calendar, X, FolderOpen, Paperclip, Link2, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant } from '../services/db';
import { isApiEnabled, apiGetDocuments, apiUploadDocument, apiDownloadDocument } from '../services/apiClient';
import { createDocument, deleteDocument } from '../services/documentWrites';
import { localeFor } from '../utils/format';
import type { Document } from '../types';
import toast from 'react-hot-toast';

const statusColors: Record<string, string> = {
  'Signed': 'bg-emerald-50 text-emerald-700',
  'Draft': 'bg-amber-50 text-amber-700',
  'Generated': 'bg-blue-50 text-blue-700',
  'Verified': 'bg-violet-50 text-violet-700',
  'Active': 'bg-emerald-50 text-emerald-700',
  'Archived': 'bg-zinc-100 text-zinc-500',
};

const documentTypes = ['Agreement', 'Quotation', 'Payment Plan', 'Legal', 'Template', 'Brochure', 'Floor Plan', 'Other'];

/** Matches what the server writes into `size`, so an uploaded file and a
 *  locally-recorded one read the same way in the list. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export default function Documents() {
  const { tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const canManage = hasPermission('manage_documents');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Feature flag: with an API URL configured, documents are read from the
  // Fastify backend (RLS-scoped). Falls back to localStorage on any API failure
  // so the page never goes blank. Flag off → identical behavior to before.
  const [apiDocuments, setApiDocuments] = useState<Document[] | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiDocuments(null); return; }
    let cancelled = false;
    apiGetDocuments()
      .then(rows => { if (!cancelled) setApiDocuments(rows); })
      .catch(() => {
        if (!cancelled) {
          setApiDocuments(null);
          toast.error('API unreachable — showing local data', { id: 'api-fallback' });
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const documents = useMemo(
    () => (apiDocuments ?? getByTenant<Document>('documents', tenantId))
      .slice().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [apiDocuments, tenantId, refreshKey]
  );

  const filtered = documents.filter(d => {
    if (typeFilter !== 'all' && d.type !== typeFilter) return false;
    if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canManage) { toast.error('You do not have permission to add documents'); return; }
    const form = e.currentTarget;
    const formData = new FormData(form);

    const name = formData.get('name') as string;
    if (!name) { toast.error('Document name is required'); return; }

    const type = (formData.get('type') as string) || 'Other';
    const project = (formData.get('project') as string) || 'General';
    const status = (formData.get('status') as string) || 'Draft';

    setBusy(true);
    try {
      if (picked && isApiEnabled()) {
        // The real path: the bytes go to the server, which owns the size and
        // the date. Nothing about the file is invented here.
        await apiUploadDocument(picked, { name, type, project, status, date: new Date().toISOString().slice(0, 10) });
      } else {
        if (picked) {
          // Local mode has nowhere to put bytes. Say so rather than recording a
          // row that claims to hold a file it does not.
          toast('Saved as a register entry — file storage needs the API', { icon: 'ℹ️' });
        }
        await createDocument({
          tenantId, name, type, project,
          date: new Date().toISOString(),
          size: picked ? humanSize(picked.size) : '—',
          status, url: '#',
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add document');
      return;
    } finally {
      setBusy(false);
    }
    setShowAdd(false);
    setPicked(null);
    refresh();
    toast.success(picked ? 'Document uploaded' : 'Document added');
  };

  const handleDelete = async (id: string) => {
    if (!canManage) { toast.error('You do not have permission to delete documents'); return; }
    if (!confirm('Delete this document?')) return;
    try {
      await deleteDocument(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete document');
      return;
    }
    refresh();
    toast.success('Document deleted');
  };

  /**
   * Pull the file down and hand it to the browser.
   *
   * The session is a Bearer token, so the URL cannot simply be navigated to —
   * it has to be fetched with the header and turned into a blob. `inNewTab`
   * previews; otherwise it saves.
   *
   * The object URL is revoked on a timer rather than immediately: revoking
   * before the browser has finished acting on the anchor cancels the download
   * in Chrome, and closes the preview tab in Firefox.
   */
  const openFile = async (doc: Document, inNewTab: boolean) => {
    if (!doc.fileId) {
      // A register entry that only points somewhere else. Honour the link if
      // there is one and say so plainly if there is not.
      if (doc.url && doc.url !== '#') { window.open(doc.url, '_blank', 'noopener,noreferrer'); return; }
      toast.error('No file is attached to this document');
      return;
    }
    setBusyId(doc.id);
    try {
      const { url, filename } = await apiDownloadDocument(doc.id);
      if (inNewTab) {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const a = window.document.createElement('a');
        a.href = url; a.download = filename;
        window.document.body.appendChild(a); a.click(); a.remove();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the file');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Documents</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Agreements, quotations, booking forms, and templates.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
            <Plus className="h-4 w-4" /> Upload Document
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search documents..."
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
          <option value="all">All Types</option>
          {documentTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
          <Filter className="h-4 w-4" /> Filters
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex flex-col items-center">
          <FolderOpen className="h-12 w-12 text-zinc-300 mb-3" />
          <h3 className="text-sm font-semibold text-zinc-700">No documents found</h3>
          <p className="text-xs text-zinc-500 mt-1">Try adjusting filters or upload a new document.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/50 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Document</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Project</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Size</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(doc => (
                  <tr key={doc.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                          <FileText className="h-4 w-4 text-indigo-500" />
                        </div>
                        <span className="text-sm font-medium text-zinc-900">{doc.name}</span>
                        {/* A register entry and a stored file look identical in
                            a list, and only one of them can actually be opened.
                            Say which is which before the user finds out. */}
                        {doc.fileId
                          ? <Paperclip className="h-3.5 w-3.5 text-indigo-400 shrink-0" aria-label="File attached" />
                          : <Link2 className="h-3.5 w-3.5 text-zinc-300 shrink-0" aria-label="Link only — no file stored" />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{doc.type}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{doc.project}</td>
                    <td className="px-4 py-3 text-sm text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" /> {new Date(doc.date).toLocaleDateString(appLocale, { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-500">{doc.size}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${statusColors[doc.status] || 'bg-zinc-100 text-zinc-500'}`}>{doc.status}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openFile(doc, true)} disabled={busyId === doc.id} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600 transition-colors disabled:opacity-50" title="View">
                          {busyId === doc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                        </button>
                        <button onClick={() => openFile(doc, false)} disabled={busyId === doc.id} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600 transition-colors disabled:opacity-50" title="Download"><Download className="h-4 w-4" /></button>
                        {canManage && (
                          <button onClick={() => handleDelete(doc.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors" title="Delete"><Trash2 className="h-4 w-4" /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Upload Document</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Document Name *</label>
                <input name="name" required placeholder="e.g., Booking Agreement - John Doe" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type</label>
                  <select name="type" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {documentTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Status</label>
                  <select name="status" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>Draft</option><option>Generated</option><option>Signed</option><option>Verified</option><option>Active</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Project</label>
                <input name="project" placeholder="e.g., Skyline Heights" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">File (optional)</label>
                <input
                  ref={fileInput} type="file" className="sr-only"
                  onChange={e => setPicked(e.target.files?.[0] ?? null)}
                />
                <div
                  role="button" tabIndex={0}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); setPicked(e.dataTransfer.files?.[0] ?? null); }}
                  className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ${picked ? 'border-indigo-300 bg-indigo-50/40' : 'border-zinc-200 hover:border-indigo-300'}`}
                >
                  {picked ? (
                    <>
                      <Paperclip className="h-6 w-6 text-indigo-500 mx-auto mb-2" />
                      <p className="text-xs font-medium text-zinc-800 truncate">{picked.name}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">{humanSize(picked.size)} — click to replace</p>
                    </>
                  ) : (
                    <>
                      <FileText className="h-6 w-6 text-zinc-400 mx-auto mb-2" />
                      <p className="text-xs text-zinc-500">Click to browse or drag &amp; drop</p>
                      <p className="text-[11px] text-zinc-400 mt-0.5">Up to 25 MB</p>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => { setShowAdd(false); setPicked(null); }} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" disabled={busy} className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm disabled:opacity-60 flex items-center justify-center gap-2">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Uploading…' : 'Upload'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
