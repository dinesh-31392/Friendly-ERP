import { useState, useMemo, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, MapPin, Calendar as CalendarIcon, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove } from '../services/db';
import { useTenantUsers } from '../hooks/useTenantUsers';
import { localeFor } from '../utils/format';
import type { Task, Lead, Priority, TaskCategory, TaskStatus } from '../types';
import toast from 'react-hot-toast';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function getMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }
  return weeks;
}

export default function Calendar() {
  const { user, tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const userId = user?.id || '';
  const isExecutive = user?.role === 'sales_executive';

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [selectedDate, setSelectedDate] = useState(new Date().getDate());
  const [viewMode, setViewMode] = useState<'month' | 'week' | 'day'>('month');
  const [showAdd, setShowAdd] = useState(false);

  // Deep linking: listen to search query focus events
  useEffect(() => {
    const focusId = localStorage.getItem('friendly_crm_focus_task');
    if (focusId) {
      const allT = getByTenant<Task>('tasks', tenantId);
      // Respect role filtering: executives only see their own tasks
      const visibleTasks = isExecutive ? allT.filter(t => t.userId === userId) : allT;
      const target = visibleTasks.find(t => t.id === focusId);
      if (target) {
        const d = new Date(target.dueDate);
        setCurrentMonth(d.getMonth());
        setCurrentYear(d.getFullYear());
        setSelectedDate(d.getDate());
        setViewMode('day');
      }
      localStorage.removeItem('friendly_crm_focus_task');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const weeks = useMemo(() => getMonthDays(currentYear, currentMonth), [currentYear, currentMonth]);

  const allTasks = useMemo(() => getByTenant<Task>('tasks', tenantId), [tenantId, refreshKey]);
  const tasks = isExecutive ? allTasks.filter(t => t.userId === userId) : allTasks;
  const leads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const users = useTenantUsers(tenantId, refreshKey);

  // Convert an ISO timestamp to the user's LOCAL calendar date — comparing
  // against the raw UTC date (`iso.split('T')[0]`) puts events on the wrong
  // day for any time/timezone where local date != UTC date
  const toLocalYMD = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const visitSchedules = useMemo(() => {
    return leads
      .filter(l => l.stage === 'visit_scheduled')
      .filter(l => !isExecutive || l.assignedTo === userId)
      .map(l => ({
        id: l.id,
        lead: l.name,
        date: toLocalYMD(l.lastContact),
        time: new Date(l.lastContact).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' }),
        project: l.project,
        type: 'visit' as const,
      }));
  }, [leads, isExecutive, userId]);

  const formatDate = (year: number, month: number, day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const hasEvent = (day: number) => {
    const dateStr = formatDate(currentYear, currentMonth, day);
    return visitSchedules.some(v => v.date === dateStr) ||
      tasks.some(t => toLocalYMD(t.dueDate) === dateStr);
  };

  const getEvents = (day: number) => {
    const dateStr = formatDate(currentYear, currentMonth, day);
    const visits = visitSchedules.filter(v => v.date === dateStr);
    const dayTasks = tasks.filter(t => toLocalYMD(t.dueDate) === dateStr);
    return [
      ...visits.map(v => ({ ...v, isTask: false })),
      ...dayTasks.map(t => ({
        id: t.id, lead: t.title,
        date: toLocalYMD(t.dueDate),
        time: new Date(t.dueDate).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' }),
        project: '', type: 'task' as const, isTask: true, taskData: t,
      })),
    ];
  };

  const selectedDayEvents = getEvents(selectedDate);

  const handleNavMonth = (dir: 1 | -1) => {
    let newMonth = currentMonth + dir;
    let newYear = currentYear;
    if (newMonth > 11) { newMonth = 0; newYear++; }
    if (newMonth < 0) { newMonth = 11; newYear--; }
    setCurrentMonth(newMonth);
    setCurrentYear(newYear);
    setSelectedDate(1);
  };

  const handleToggleTask = (task: Task) => {
    const newStatus: TaskStatus = task.status === 'completed' ? 'pending' : 'completed';
    update<Task>('tasks', task.id, { status: newStatus });
    refresh();
    toast.success(newStatus === 'completed' ? 'Task completed' : 'Task reopened');
  };

  const handleDeleteTask = (id: string) => {
    if (!confirm('Delete this task?')) return;
    remove('tasks', id);
    refresh();
    toast.success('Task deleted');
  };

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    const title = formData.get('title') as string;
    const dateStr = formData.get('date') as string;
    const timeStr = formData.get('time') as string;
    if (!title || !dateStr) { toast.error('Title and date are required'); return; }

    const dueDate = new Date(`${dateStr}T${timeStr || '10:00'}`).toISOString();

    create<Task>('tasks', {
      id: '', tenantId, userId: (formData.get('userId') as string) || userId,
      title,
      description: (formData.get('description') as string) || '',
      dueDate,
      priority: (formData.get('priority') as Priority) || 'warm',
      status: 'pending',
      category: (formData.get('category') as TaskCategory) || 'other',
    });
    setShowAdd(false);
    refresh();
    toast.success('Task added');
  };

  const upcomingTasks = tasks.filter(t => t.status !== 'completed')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
    .slice(0, 5);

  return (
    <div className="flex gap-6 max-w-[1400px] flex-col lg:flex-row">
      <div className="flex-1">
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-zinc-900">{monthNames[currentMonth]} {currentYear}</h2>
              <div className="flex items-center gap-1">
                <button onClick={() => handleNavMonth(-1)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500"><ChevronLeft className="h-4 w-4" /></button>
                <button onClick={() => handleNavMonth(1)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500"><ChevronRight className="h-4 w-4" /></button>
                <button
                  onClick={() => {
                    const now = new Date();
                    setCurrentMonth(now.getMonth());
                    setCurrentYear(now.getFullYear());
                    setSelectedDate(now.getDate());
                  }}
                  className="px-2 py-1 rounded-lg hover:bg-zinc-100 text-zinc-500 text-xs font-medium"
                >
                  Today
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-zinc-100 rounded-xl p-1">
                {(['month', 'week', 'day'] as const).map(m => (
                  <button key={m} onClick={() => setViewMode(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${viewMode === m ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                  >{m}</button>
                ))}
              </div>
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors">
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
          </div>
          {viewMode === 'month' && (
            <div className="p-2">
              <div className="grid grid-cols-7 mb-1">
                {days.map(d => <div key={d} className="text-center py-2 text-xs font-semibold text-zinc-400 uppercase">{d}</div>)}
              </div>
              {weeks.map((week, wi) => (
                <div key={wi} className="grid grid-cols-7">
                  {week.map((day, di) => (
                    <div key={di}
                      className={`min-h-[90px] border border-transparent hover:border-zinc-200 rounded-xl p-1.5 cursor-pointer transition-all ${
                        day === selectedDate ? 'bg-indigo-50 border-indigo-200' : ''
                      } ${!day ? 'pointer-events-none opacity-40' : ''}`}
                      onClick={() => day && setSelectedDate(day)}
                    >
                      {day && (
                        <>
                          <p className={`text-xs font-semibold mb-1 ${day === selectedDate ? 'text-indigo-700' : 'text-zinc-600'}`}>{day}</p>
                          {hasEvent(day) && (
                            <div className="space-y-0.5">
                              {getEvents(day).slice(0, 2).map(ev => (
                                <div key={ev.id} className={`text-[10px] px-1.5 py-0.5 rounded font-medium truncate ${ev.type === 'visit' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {ev.time} {ev.lead}
                                </div>
                              ))}
                              {getEvents(day).length > 2 && (
                                <p className="text-[10px] text-zinc-400 font-medium">+{getEvents(day).length - 2} more</p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {(viewMode === 'day' || viewMode === 'week') && (
            <div className="p-5">
              <h4 className="text-sm font-semibold text-zinc-700 mb-3">
                Events on {monthNames[currentMonth]} {selectedDate}, {currentYear}
              </h4>
              {selectedDayEvents.length === 0 ? (
                <div className="py-12 text-center text-sm text-zinc-400">No events scheduled for this day</div>
              ) : (
                <div className="space-y-2">
                  {selectedDayEvents.map(ev => (
                    <div key={ev.id} className="flex items-center gap-3 p-3 rounded-xl border border-zinc-100 hover:bg-zinc-50">
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${ev.type === 'visit' ? 'bg-indigo-50' : 'bg-amber-50'}`}>
                        {ev.type === 'visit' ? <MapPin className="h-5 w-5 text-indigo-500" /> : <Clock className="h-5 w-5 text-amber-500" />}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-zinc-900">{ev.lead}</p>
                        <div className="flex items-center gap-3 text-xs text-zinc-500 mt-0.5">
                          <span>{ev.time}</span>
                          {ev.project && <span>{ev.project}</span>}
                        </div>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${ev.type === 'visit' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>{ev.type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="w-full lg:w-80 shrink-0 space-y-4">
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <h3 className="font-semibold text-zinc-900 mb-3 flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-indigo-500" /> Upcoming Visits
          </h3>
          <div className="space-y-3">
            {visitSchedules.slice(0, 4).map(ev => (
              <div key={ev.id} className="flex gap-3 p-2.5 rounded-xl hover:bg-zinc-50 transition-colors">
                <div className="text-center shrink-0">
                  <p className="text-lg font-bold text-zinc-900">{new Date(`${ev.date}T00:00:00`).getDate()}</p>
                  <p className="text-[10px] font-medium text-zinc-400 uppercase">{new Date(`${ev.date}T00:00:00`).toLocaleDateString(appLocale, { month: 'short' })}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-800 truncate">{ev.lead}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-zinc-500">
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {ev.time}</span>
                    {ev.project && <span className="flex items-center gap-1 truncate"><MapPin className="h-3 w-3" /> {ev.project}</span>}
                  </div>
                </div>
              </div>
            ))}
            {visitSchedules.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No upcoming visits</p>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <h3 className="font-semibold text-zinc-900 mb-3">Pending Tasks</h3>
          <div className="space-y-1">
            {upcomingTasks.map(task => (
              <div key={task.id} className="flex items-center gap-3 py-2 border-b border-zinc-50 last:border-0 group">
                <input
                  type="checkbox"
                  checked={task.status === 'completed'}
                  onChange={() => handleToggleTask(task)}
                  className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${task.status === 'completed' ? 'text-zinc-400 line-through' : 'text-zinc-700'}`}>{task.title}</p>
                  <p className="text-[11px] text-zinc-400 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(task.dueDate).toLocaleDateString(appLocale, { day: 'numeric', month: 'short' })}
                  </p>
                </div>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${
                  task.priority === 'hot' ? 'bg-red-50 text-red-600' : task.priority === 'warm' ? 'bg-amber-50 text-amber-600' : 'bg-zinc-100 text-zinc-500'
                }`}>{task.priority}</span>
                <button onClick={() => handleDeleteTask(task.id)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-opacity">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {upcomingTasks.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No pending tasks</p>}
          </div>
        </div>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Add Task / Event</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Title *</label>
                <input name="title" required placeholder="e.g., Follow up with John" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Description</label>
                <textarea name="description" rows={2} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Date *</label>
                  <input name="date" type="date" required defaultValue={formatDate(currentYear, currentMonth, selectedDate)} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Time</label>
                  <input name="time" type="time" defaultValue="10:00" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Priority</label>
                  <select name="priority" defaultValue="warm" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Category</label>
                  <select name="category" defaultValue="follow_up" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option value="follow_up">Follow-up</option><option value="visit">Visit</option><option value="payment">Payment</option><option value="service">Service</option><option value="other">Other</option>
                  </select>
                </div>
                {!isExecutive && (
                  <div className="col-span-2">
                    <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Assign To</label>
                    <select name="userId" defaultValue={userId} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                      {users.filter(u => u.active && u.role !== 'super_admin').map(u => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
