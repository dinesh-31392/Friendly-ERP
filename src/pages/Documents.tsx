import { useState, useMemo } from 'react';
import { FileText, Search, Plus, Download, Eye, Trash2, Filter, Calendar, X, FolderOpen } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, remove } from '../services/db';
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

  const documents = useMemo(
    () => getByTenant<Document>('documents', tenantId).sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    ),
    [tenantId, refreshKey]
  );

  const filtered = documents.filter(d => {
    if (typeFilter !== 'all' && d.type !== typeFilter) return false;
    if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);

    const name = formData.get('name') as string;
    if (!name) { toast.error('Document name is required'); return; }

    create<Document>('documents', {
      id: '', tenantId, name,
      type: (formData.get('type') as string) || 'Other',
      project: (formData.get('project') as string) || 'General',
      date: new Date().toISOString(),
      size: `${Math.floor(Math.random() * 500 + 50)} KB`,
      status: (formData.get('status') as string) || 'Draft',
      url: '#',
    });
    setShowAdd(false);
    refresh();
    toast.success('Document added successfully');
  };

  const handleDelete = (id: string) => {
    if (!canManage) { toast.error('You do not have permission to delete documents'); return; }
    if (!confirm('Delete this document?')) return;
    remove('documents', id);
    refresh();
    toast.success('Document deleted');
  };

  const handleDownload = (name: string) => {
    toast.success(`Downloading ${name}...`);
  };

  const handleView = (name: string) => {
    toast.success(`Opening ${name}`);
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
                        <button onClick={() => handleView(doc.name)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600 transition-colors" title="View"><Eye className="h-4 w-4" /></button>
                        <button onClick={() => handleDownload(doc.name)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600 transition-colors" title="Download"><Download className="h-4 w-4" /></button>
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
                <div className="border-2 border-dashed border-zinc-200 rounded-xl p-6 text-center hover:border-indigo-300 transition-colors cursor-pointer">
                  <FileText className="h-6 w-6 text-zinc-400 mx-auto mb-2" />
                  <p className="text-xs text-zinc-500">Click to browse or drag & drop</p>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Upload</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
