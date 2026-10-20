import React, { useState } from 'react';
import { UserProfile, Ticket, ActiveScreen, Order, UserVehicle, AppNotification } from '../types';
import { supabase } from '../lib/supabase';
import {
  User,
  Ticket as TicketIcon,
  ShoppingBag,
  Car,
  Bell,
  Settings,
  LogOut,
  CheckCircle2,
  Clock,
  ArrowRight,
  ShieldCheck,
  Save,
  Plus,
  Trash2,
  Calendar,
  CreditCard,
  AlertCircle,
  Check,
  Sparkles,
  LayoutDashboard,
} from 'lucide-react';

export type ProfileTab = 'profile' | 'tickets' | 'orders' | 'vehicles' | 'notifications';

interface ProfileViewProps {
  user: UserProfile;
  tickets: Ticket[];
  initialTab?: ProfileTab;
  onUpdateProfile: (updated: Partial<UserProfile>) => void;
  onSelectTicket: (ticket: Ticket) => void;
  onNavigate: (screen: ActiveScreen, initialTab?: ProfileTab) => void;
  onLogout: () => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({
  user,
  tickets,
  initialTab = 'profile',
  onUpdateProfile,
  onSelectTicket,
  onNavigate,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<ProfileTab>(initialTab);
  const [subTab, setSubTab] = useState<'personal' | 'address'>('personal');

  // Sincronizar tab externa quando selecionada via header ou mobile nav
  React.useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Form states
  const [fullName, setFullName] = useState(user.full_name);
  const [email] = useState(user.email);
  const [phone, setPhone] = useState(user.phone);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Vehicles state
  const [vehicles, setVehicles] = useState<UserVehicle[]>(user.vehicles || []);
  const [newVehicleModel, setNewVehicleModel] = useState('');
  const [newVehiclePlate, setNewVehiclePlate] = useState('');
  const [newVehicleYear, setNewVehicleYear] = useState('2020');
  const [newVehiclePhoto, setNewVehiclePhoto] = useState('');
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [vehicleSavedMessage, setVehicleSavedMessage] = useState(false);

  // Orders state
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [ordersFilter, setOrdersFilter] = useState<'all' | 'approved' | 'pending'>('all');

  // Notifications state: derivado exclusivamente de fontes de dados reais (ingressos e pedidos verificados)
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifFilter, setNotifFilter] = useState<'all' | 'unread'>('all');
  const [readNotifIds, setReadNotifIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('px_read_notifications');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Derivar notificações autênticas a partir dos ingressos reais do usuário
  React.useEffect(() => {
    const derivedNotifs: AppNotification[] = [];

    if (tickets && tickets.length > 0) {
      tickets.forEach((t) => {
        if (t.status === 'paid') {
          const notifId = `notif-tkt-${t.id}-paid`;
          derivedNotifs.push({
            id: notifId,
            title: 'Ingresso Confirmado',
            message: `Ingresso ${t.code} (${t.batch_name}) confirmado para "${t.event_title}". O QR Code está disponível para validação.`,
            type: 'ticket',
            read: readNotifIds.has(notifId),
            created_at: t.created_at || new Date().toISOString(),
          });
        } else if (t.status === 'used') {
          const notifId = `notif-tkt-${t.id}-used`;
          derivedNotifs.push({
            id: notifId,
            title: 'Check-in Realizado',
            message: `Check-in oficial registrado com o ingresso ${t.code} (${t.batch_name}).`,
            type: 'ticket',
            read: readNotifIds.has(notifId),
            created_at: t.checkin_at || t.created_at || new Date().toISOString(),
          });
        } else if (t.status === 'pending') {
          const notifId = `notif-tkt-${t.id}-pending`;
          derivedNotifs.push({
            id: notifId,
            title: 'Aguardando Pagamento',
            message: `Ingresso ${t.code} para "${t.event_title}" aguarda confirmação do pagamento pelo Mercado Pago.`,
            type: 'payment',
            read: readNotifIds.has(notifId),
            created_at: t.created_at || new Date().toISOString(),
          });
        }
      });
    }

    derivedNotifs.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    setNotifications(derivedNotifs);
  }, [tickets, readNotifIds]);

  // 1. Carregar veículos sincronizados com o Supabase
  React.useEffect(() => {
    if (!user?.id) return;
    async function fetchUserVehicles() {
      try {
        const { data, error } = await supabase
          .from('vehicles')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (!error && data && data.length > 0) {
          setVehicles(data);
        }
      } catch {
        // Fallback silencioso mantendo veículos do perfil
      }
    }
    fetchUserVehicles();
  }, [user.id]);

  // 2. Carregar pedidos oficiais do usuário diretamente do Supabase
  React.useEffect(() => {
    if (!user?.id) return;
    async function fetchUserOrders() {
      setOrdersLoading(true);
      setOrdersError(null);
      try {
        const { data, error } = await supabase
          .from('orders')
          .select('*, events(title), order_items(*)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        setOrdersLoading(false);
        if (error) {
          console.warn('[PX CUSTON] Erro ao consultar pedidos no Supabase:', error.message);
          setOrdersError('Falha ao consultar pedidos no servidor: ' + error.message);
          return;
        }

        if (data && data.length > 0) {
          const mapped: Order[] = data.map((d: any) => ({
            id: d.id,
            user_id: d.user_id,
            event_id: d.event_id,
            event_title: d.events?.title || 'PX CUSTON',
            items: (d.order_items || []).map((it: any) => ({
              batch_id: it.batch_id,
              batch_name: 'Ingresso Oficial',
              quantity: it.quantity,
              unit_price: Number(it.unit_price),
              subtotal: Number(it.subtotal),
            })),
            subtotal: Number(d.subtotal),
            convenience_fee: Number(d.convenience_fee || 0),
            discount: Number(d.discount || 0),
            total: Number(d.total),
            payment_method: d.payment_method || 'pix',
            payment_status: d.payment_status || 'pending',
            mercado_pago_id: d.mercado_pago_id,
            created_at: d.created_at,
          }));
          setOrders(mapped);
        } else {
          setOrders([]);
        }
      } catch (err: any) {
        setOrdersLoading(false);
        setOrdersError('Erro de conexão ao carregar pedidos.');
      }
    }
    fetchUserOrders();
  }, [user.id]);

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateProfile({
      full_name: fullName,
      phone,
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVehicleModel || !newVehiclePlate) return;
    const added: UserVehicle = {
      id: `veh-${Date.now()}`,
      user_id: user.id,
      model: newVehicleModel.trim(),
      year: parseInt(newVehicleYear, 10) || 2020,
      license_plate: newVehiclePlate.trim().toUpperCase(),
      photo_url:
        newVehiclePhoto.trim() ||
        'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=400&q=80',
    };
    const updated = [added, ...vehicles];
    setVehicles(updated);
    onUpdateProfile({ vehicles: updated });
    setNewVehicleModel('');
    setNewVehiclePlate('');
    setNewVehiclePhoto('');
    setShowAddVehicle(false);
    setVehicleSavedMessage(true);
    setTimeout(() => setVehicleSavedMessage(false), 3000);

    // Persistência segura na tabela public.vehicles do Supabase
    try {
      if (user.id && !user.id.startsWith('usr-deivid')) {
        await supabase.from('vehicles').insert({
          user_id: user.id,
          model: added.model,
          year: added.year,
          license_plate: added.license_plate,
          photo_url: added.photo_url,
        });
      }
    } catch (err) {
      console.warn('[Supabase] Falha ao persistir veículo:', err);
    }
  };

  const handleDeleteVehicle = async (vehicleId: string) => {
    const updated = vehicles.filter((v) => v.id !== vehicleId);
    setVehicles(updated);
    onUpdateProfile({ vehicles: updated });

    try {
      if (user.id && !user.id.startsWith('usr-deivid') && !vehicleId.startsWith('veh-')) {
        await supabase.from('vehicles').delete().eq('id', vehicleId).eq('user_id', user.id);
      }
    } catch (err) {
      console.warn('[Supabase] Falha ao excluir veículo:', err);
    }
  };

  const handleMarkAllNotifsRead = () => {
    const allIds = new Set(notifications.map((n) => n.id));
    setReadNotifIds(allIds);
    try {
      localStorage.setItem('px_read_notifications', JSON.stringify(Array.from(allIds)));
    } catch {
      // ignore
    }
  };

  const handleToggleNotifRead = (id: string) => {
    setReadNotifIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        localStorage.setItem('px_read_notifications', JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const filteredOrders = orders.filter((o) => {
    if (ordersFilter === 'approved') return o.payment_status === 'approved';
    if (ordersFilter === 'pending') return o.payment_status === 'pending';
    return true;
  });

  const filteredNotifs = notifications.filter((n) => {
    if (notifFilter === 'unread') return !n.read;
    return true;
  });

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="min-h-screen bg-[#000000] text-white py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-8">
        {/* Left Sidebar Navigation */}
        <div className="md:col-span-1 space-y-2">
          {/* User mini summary badge */}
          <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-[#FF1A2D] text-white font-black text-lg flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(255,26,45,0.4)]">
              {user.full_name ? user.full_name.charAt(0).toUpperCase() : 'P'}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold truncate text-white">{user.full_name}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-3 h-3" /> Verificado
                </span>
                {user.role === 'SUPER_ADMIN' ? (
                  <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-[#FF1A2D]/20 text-[#FF1A2D] border border-[#FF1A2D]/40">
                    SUPER ADMIN
                  </span>
                ) : user.role === 'ADMIN' ? (
                  <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-[#FF1A2D]/20 text-[#FF1A2D] border border-[#FF1A2D]/40">
                    ADMIN
                  </span>
                ) : user.role === 'CHECKIN_OPERATOR' ? (
                  <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-blue-950/40 text-blue-400 border border-blue-500/30">
                    OPERADOR
                  </span>
                ) : (
                  <span className="text-[9px] font-mono text-zinc-400">
                    CLIENTE PX
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Atalho de Destaque PX CONTROL para Administradores */}
          {['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
            <div className="bg-[#181112] border border-[#FF1A2D]/40 p-3.5 rounded-2xl mb-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-[#FF1A2D] uppercase tracking-wider flex items-center gap-1.5 font-heading">
                  <ShieldCheck className="w-4 h-4" /> PX CONTROL
                </span>
                <span className="text-[9px] bg-[#FF1A2D] text-white font-extrabold px-1.5 py-0.5 rounded uppercase font-mono">
                  {user.role}
                </span>
              </div>
              <p className="text-[11px] text-zinc-300 leading-snug">
                Painel administrativo de métricas, pedidos oficiais e configurações do sistema.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('admin_dashboard')}
                className="w-full bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold py-2 px-3 rounded-xl flex items-center justify-center gap-2 shadow-[0_0_12px_rgba(255,26,45,0.3)] transition"
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
                <span>Abrir PX CONTROL</span>
              </button>
            </div>
          )}

          <div className="bg-[#121212] border border-[#222] rounded-2xl p-2 space-y-1">
            {/* 1. Meu Perfil */}
            <button
              onClick={() => setActiveTab('profile')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-3 transition ${
                activeTab === 'profile'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <User className="w-4 h-4" />
              <span>Meu Perfil</span>
            </button>

            {/* 2. Meus Ingressos */}
            <button
              onClick={() => setActiveTab('tickets')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-between transition ${
                activeTab === 'tickets'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <TicketIcon className="w-4 h-4" />
                <span>Meus Ingressos</span>
              </div>
              {tickets.length > 0 && (
                <span className="bg-[#222] text-zinc-300 text-[10px] px-2 py-0.5 rounded-full font-mono">
                  {tickets.length}
                </span>
              )}
            </button>

            {/* 3. Meus Pedidos */}
            <button
              onClick={() => setActiveTab('orders')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-between transition ${
                activeTab === 'orders'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingBag className="w-4 h-4" />
                <span>Meus Pedidos</span>
              </div>
              {orders.length > 0 && (
                <span className="bg-[#222] text-zinc-300 text-[10px] px-2 py-0.5 rounded-full font-mono">
                  {orders.length}
                </span>
              )}
            </button>

            {/* 4. Meus Veículos */}
            <button
              onClick={() => setActiveTab('vehicles')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-between transition ${
                activeTab === 'vehicles'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <Car className="w-4 h-4" />
                <span>Meus Veículos</span>
              </div>
              {vehicles.length > 0 && (
                <span className="bg-[#222] text-zinc-300 text-[10px] px-2 py-0.5 rounded-full font-mono">
                  {vehicles.length}
                </span>
              )}
            </button>

            {/* 5. Notificações */}
            <button
              onClick={() => setActiveTab('notifications')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-between transition ${
                activeTab === 'notifications'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <div className="flex items-center gap-3">
                <Bell className="w-4 h-4" />
                <span>Notificações</span>
              </div>
              {unreadCount > 0 && (
                <span className="bg-[#FF1A2D] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {unreadCount}
                </span>
              )}
            </button>

            {/* Atalhos Administrativos PX CONTROL (exclusivo para ADMIN e SUPER_ADMIN) */}
            {['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
              <div className="pt-2 border-t border-[#1e1e1e] space-y-1">
                <button
                  onClick={() => onNavigate('admin_dashboard')}
                  className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-3 bg-[#FF1A2D]/15 border border-[#FF1A2D]/40 text-[#FF1A2D] hover:bg-[#FF1A2D] hover:text-white transition shadow-[0_0_15px_rgba(255,26,45,0.2)]"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>Painel PX CONTROL</span>
                </button>

                <button
                  onClick={() => onNavigate('admin_payments')}
                  className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-3 text-zinc-400 hover:text-white hover:bg-[#181818] transition"
                >
                  <Settings className="w-4 h-4" />
                  <span>Configurações do Sistema</span>
                </button>
              </div>
            )}

            <div className="pt-2 border-t border-[#1e1e1e]">
              <button
                onClick={onLogout}
                className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-3 text-red-400 hover:bg-red-950/30 transition"
              >
                <LogOut className="w-4 h-4" />
                <span>Sair</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Main Content */}
        <div className="md:col-span-3 space-y-6">
          {/* TAB 1: MEU PERFIL */}
          {activeTab === 'profile' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8">
              <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading">
                Meu Perfil
              </h2>

              {/* Sub-tabs: Dados Pessoais | Endereço */}
              <div className="flex items-center gap-3 border-b border-[#222] mt-4 mb-6">
                <button
                  onClick={() => setSubTab('personal')}
                  className={`pb-2.5 text-xs font-bold uppercase tracking-wider transition border-b-2 ${
                    subTab === 'personal'
                      ? 'border-[#FF1A2D] text-[#FF1A2D]'
                      : 'border-transparent text-zinc-400 hover:text-white'
                  }`}
                >
                  Dados Pessoais
                </button>
                <button
                  onClick={() => setSubTab('address')}
                  className={`pb-2.5 text-xs font-bold uppercase tracking-wider transition border-b-2 ${
                    subTab === 'address'
                      ? 'border-[#FF1A2D] text-[#FF1A2D]'
                      : 'border-transparent text-zinc-400 hover:text-white'
                  }`}
                >
                  Endereço
                </button>
              </div>

              {savedSuccess && (
                <div className="mb-4 bg-emerald-950/50 border border-emerald-500/50 text-emerald-200 text-xs p-3 rounded-xl flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Dados atualizados com sucesso no Supabase!</span>
                </div>
              )}

              {/* Informação de Papel Administrativo */}
              {['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
                <div className="mb-5 bg-[#181112] border border-[#FF1A2D]/30 text-xs p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <ShieldCheck className="w-5 h-5 text-[#FF1A2D] shrink-0" />
                    <div>
                      <span className="text-zinc-200 block">
                        Privilégio de acesso: <strong className="text-white">{user.role === 'SUPER_ADMIN' ? 'Super Administrador' : 'Administrador'}</strong>
                      </span>
                      <span className="text-[11px] text-zinc-400">
                        Você possui autorização para acessar o painel PX CONTROL.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigate('admin_dashboard')}
                    className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold px-3.5 py-2 rounded-xl shrink-0 transition flex items-center justify-center gap-1.5 shadow-[0_0_10px_rgba(255,26,45,0.3)]"
                  >
                    <LayoutDashboard className="w-3.5 h-3.5" />
                    <span>Acessar PX CONTROL</span>
                  </button>
                </div>
              )}

              {subTab === 'personal' && (
                <form onSubmit={handleSaveProfile} className="space-y-4 max-w-lg">
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">
                      Nome Completo
                    </label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-xs text-white"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">
                      E-mail (Supabase Auth)
                    </label>
                    <input
                      type="email"
                      disabled
                      value={email}
                      className="w-full bg-[#151515] border border-[#222] text-zinc-500 rounded-xl px-3.5 py-2.5 text-xs cursor-not-allowed"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1">
                      Telefone
                    </label>
                    <input
                      type="text"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-xs text-white"
                    />
                  </div>

                  <button
                    type="submit"
                    className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-6 py-3 rounded-xl shadow transition flex items-center gap-2 mt-4"
                  >
                    <Save className="w-4 h-4" />
                    <span>Atualizar Perfil</span>
                  </button>
                </form>
              )}

              {subTab === 'address' && (
                <div className="text-xs text-zinc-400 py-6">
                  <p className="font-semibold text-zinc-200">Manhuaçu / MG — Brasil</p>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Endereço principal salvo para emissão de notas fiscais e credenciais oficiais.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: MEUS VEÍCULOS */}
          {activeTab === 'vehicles' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8 space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222] pb-5">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                    <Car className="w-5 h-5 text-[#FF1A2D]" />
                    <span>Meus Veículos Cadastrados</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Cadastre seus projetos automotivos para exposição e acesso especial aos eventos PX CUSTON.
                  </p>
                </div>

                <button
                  onClick={() => setShowAddVehicle(!showAddVehicle)}
                  className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl shadow transition flex items-center gap-2 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>{showAddVehicle ? 'Fechar Formulário' : '+ Novo Veículo'}</span>
                </button>
              </div>

              {vehicleSavedMessage && (
                <div className="bg-emerald-950/50 border border-emerald-500/50 text-emerald-200 text-xs p-3 rounded-xl flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Veículo salvo com sucesso e vinculado ao seu perfil!</span>
                </div>
              )}

              {/* Formulário de Adicionar Veículo */}
              {showAddVehicle && (
                <form
                  onSubmit={handleAddVehicle}
                  className="bg-[#181818] p-5 rounded-2xl border border-[#2a2a2a] space-y-4 animate-fade-in"
                >
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                    Cadastrar Novo Veículo / Projeto
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                        Modelo do Carro *
                      </label>
                      <input
                        type="text"
                        placeholder="Ex: Chevrolet Opala SS 1978"
                        required
                        value={newVehicleModel}
                        onChange={(e) => setNewVehicleModel(e.target.value)}
                        className="w-full bg-[#121212] border border-[#333] focus:border-[#FF1A2D] focus:outline-none text-xs p-2.5 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                        Placa do Veículo *
                      </label>
                      <input
                        type="text"
                        placeholder="Ex: ABC-1234 ou ABC1D23"
                        required
                        value={newVehiclePlate}
                        onChange={(e) => setNewVehiclePlate(e.target.value)}
                        className="w-full bg-[#121212] border border-[#333] focus:border-[#FF1A2D] focus:outline-none text-xs p-2.5 rounded-xl text-white uppercase font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                        Ano de Fabricação
                      </label>
                      <input
                        type="number"
                        placeholder="Ex: 1980"
                        value={newVehicleYear}
                        onChange={(e) => setNewVehicleYear(e.target.value)}
                        className="w-full bg-[#121212] border border-[#333] focus:border-[#FF1A2D] focus:outline-none text-xs p-2.5 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                        URL da Foto do Projeto (Opcional)
                      </label>
                      <input
                        type="url"
                        placeholder="https://..."
                        value={newVehiclePhoto}
                        onChange={(e) => setNewVehiclePhoto(e.target.value)}
                        className="w-full bg-[#121212] border border-[#333] focus:border-[#FF1A2D] focus:outline-none text-xs p-2.5 rounded-xl text-white"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAddVehicle(false)}
                      className="px-4 py-2 bg-[#222] hover:bg-[#2a2a2a] text-zinc-300 text-xs font-semibold rounded-xl"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2 bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider rounded-xl shadow"
                    >
                      Salvar Veículo
                    </button>
                  </div>
                </form>
              )}

              {/* Grid de Veículos */}
              {vehicles.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[#262626] rounded-2xl p-6">
                  <div className="w-14 h-14 rounded-2xl bg-[#181818] border border-[#333] flex items-center justify-center mx-auto mb-3 text-zinc-400">
                    <Car className="w-7 h-7 text-[#FF1A2D]" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase">Nenhum Veículo Cadastrado</h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto mt-1 mb-4">
                    Adicione seus carros e projetos para participar de exposições e desfrutar de acesso prioritário nos encontros PX CUSTON.
                  </p>
                  <button
                    onClick={() => setShowAddVehicle(true)}
                    className="bg-[#FF1A2D] text-white text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-xl"
                  >
                    + Cadastrar Primeiro Veículo
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {vehicles.map((v) => (
                    <div
                      key={v.id}
                      className="bg-[#181818] border border-[#262626] hover:border-[#383838] p-4 rounded-2xl flex items-center gap-4 transition group"
                    >
                      <img
                        src={
                          v.photo_url ||
                          'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=400&q=80'
                        }
                        alt={v.model}
                        className="w-20 h-20 rounded-xl object-cover shrink-0 border border-[#333]"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-[10px] text-[#FF1A2D] font-bold uppercase tracking-wider">
                          Ano {v.year || 2020}
                        </span>
                        <h4 className="text-sm font-bold text-white truncate">{v.model}</h4>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          Placa:{' '}
                          <span className="text-zinc-200 font-mono font-bold bg-[#111] px-2 py-0.5 rounded border border-[#2a2a2a]">
                            {v.license_plate}
                          </span>
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() => handleDeleteVehicle(v.id)}
                            className="text-[11px] text-zinc-400 hover:text-red-400 flex items-center gap-1 transition"
                            title="Remover veículo"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Remover</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: MEUS PEDIDOS */}
          {activeTab === 'orders' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8 space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222] pb-5">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                    <ShoppingBag className="w-5 h-5 text-[#FF1A2D]" />
                    <span>Meus Pedidos & Compras</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Histórico consolidado de compras de ingressos e pagamentos via Mercado Pago.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setOrdersFilter('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      ordersFilter === 'all'
                        ? 'bg-[#FF1A2D] text-white'
                        : 'bg-[#181818] text-zinc-400 hover:text-white'
                    }`}
                  >
                    Todos ({orders.length})
                  </button>
                  <button
                    onClick={() => setOrdersFilter('approved')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      ordersFilter === 'approved'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-[#181818] text-zinc-400 hover:text-white'
                    }`}
                  >
                    Aprovados
                  </button>
                  <button
                    onClick={() => setOrdersFilter('pending')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      ordersFilter === 'pending'
                        ? 'bg-amber-600 text-white'
                        : 'bg-[#181818] text-zinc-400 hover:text-white'
                    }`}
                  >
                    Pendentes
                  </button>
                </div>
              </div>

              {ordersLoading ? (
                <div className="py-12 text-center text-zinc-400 text-xs">
                  <Clock className="w-6 h-6 animate-spin mx-auto mb-2 text-[#FF1A2D]" />
                  <span>Carregando pedidos oficiais...</span>
                </div>
              ) : ordersError ? (
                <div className="text-center py-12 border border-dashed border-amber-900/40 rounded-2xl p-6 bg-amber-950/10">
                  <div className="w-14 h-14 rounded-2xl bg-[#181818] border border-amber-500/30 flex items-center justify-center mx-auto mb-3 text-amber-500">
                    <AlertCircle className="w-7 h-7 text-amber-500" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase">Falha na Consulta de Pedidos</h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto mt-1 mb-2">
                    {ordersError}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    Verifique sua conexão ou tente recarregar a página.
                  </p>
                </div>
              ) : filteredOrders.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[#262626] rounded-2xl p-6">
                  <div className="w-14 h-14 rounded-2xl bg-[#181818] border border-[#333] flex items-center justify-center mx-auto mb-3 text-zinc-400">
                    <ShoppingBag className="w-7 h-7 text-[#FF1A2D]" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase">Nenhum Pedido Encontrado</h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto mt-1 mb-4">
                    Você ainda não possui pedidos com este status na plataforma oficial PX CUSTON.
                  </p>
                  <button
                    onClick={() => onNavigate('events')}
                    className="bg-[#FF1A2D] text-white text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-xl"
                  >
                    Ver Eventos Disponíveis
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredOrders.map((ord) => (
                    <div
                      key={ord.id}
                      className="bg-[#181818] border border-[#262626] hover:border-[#383838] p-5 rounded-2xl space-y-4 transition"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#242424] pb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white uppercase font-heading">
                              {ord.event_title}
                            </span>
                            <span className="text-[10px] font-mono text-zinc-400 bg-[#121212] px-2 py-0.5 rounded border border-[#2a2a2a]">
                              {ord.id}
                            </span>
                          </div>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            Data da compra: {new Date(ord.created_at).toLocaleDateString('pt-BR')} às{' '}
                            {new Date(ord.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>

                        <div>
                          {ord.payment_status === 'approved' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-3 py-1 rounded-full">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Pagamento Aprovado
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-400 bg-amber-950/40 border border-amber-500/30 px-3 py-1 rounded-full">
                              <Clock className="w-3.5 h-3.5" /> Aguardando Pagamento
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Itens do pedido */}
                      <div className="space-y-1.5 text-xs text-zinc-300">
                        {ord.items.map((it, idx) => (
                          <div key={idx} className="flex justify-between items-center py-1">
                            <span>
                              {it.quantity}x {it.batch_name}
                            </span>
                            <span className="font-mono text-zinc-400">
                              R$ {(it.unit_price * it.quantity).toFixed(2).replace('.', ',')}
                            </span>
                          </div>
                        ))}
                        {ord.convenience_fee > 0 && (
                          <div className="flex justify-between items-center text-[11px] text-zinc-400 pt-1 border-t border-[#222]">
                            <span>Taxa de Conveniência</span>
                            <span className="font-mono">R$ {ord.convenience_fee.toFixed(2).replace('.', ',')}</span>
                          </div>
                        )}
                      </div>

                      {/* Total e Ações */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-[#242424]">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-zinc-400 uppercase font-semibold">Total:</span>
                          <span className="text-base font-black text-[#FF1A2D] font-heading font-mono">
                            R$ {ord.total.toFixed(2).replace('.', ',')}
                          </span>
                          <span className="text-[10px] text-zinc-400 uppercase bg-[#141414] px-2 py-0.5 rounded border border-[#2a2a2a] ml-1">
                            {ord.payment_method.toUpperCase()}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setActiveTab('tickets');
                            }}
                            className="bg-[#242424] hover:bg-[#FF1A2D] hover:text-white text-zinc-200 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-xl transition flex items-center gap-1.5"
                          >
                            <TicketIcon className="w-3.5 h-3.5" />
                            <span>Ver Ingressos</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: MEUS INGRESSOS (COMPLETO) */}
          {activeTab === 'tickets' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8 space-y-6">
              <div className="flex items-center justify-between border-b border-[#222] pb-5">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                    <TicketIcon className="w-5 h-5 text-[#FF1A2D]" />
                    <span>Meus Ingressos Oficiais</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Ingressos emitidos com QR Code criptografado para validação na portaria.
                  </p>
                </div>
                <button
                  onClick={() => onNavigate('events')}
                  className="text-xs text-[#FF1A2D] font-bold hover:underline"
                >
                  + Comprar Ingressos
                </button>
              </div>

              {tickets.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[#262626] rounded-2xl p-6">
                  <div className="w-14 h-14 rounded-2xl bg-[#181818] border border-[#333] flex items-center justify-center mx-auto mb-3 text-zinc-400">
                    <TicketIcon className="w-7 h-7 text-[#FF1A2D]" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase">Nenhum Ingresso Encontrado</h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto mt-1 mb-4">
                    Garanta seu lugar nos melhores encontros automotivos da PX CUSTON.
                  </p>
                  <button
                    onClick={() => onNavigate('events')}
                    className="bg-[#FF1A2D] text-white text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-xl"
                  >
                    Ver Eventos Oficiais
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {tickets.map((tkt) => (
                    <div
                      key={tkt.id}
                      className="bg-[#181818] border border-[#262626] hover:border-[#383838] p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-[#222] flex items-center justify-center text-[#FF1A2D] shrink-0 border border-[#333]">
                          <TicketIcon className="w-7 h-7" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-white uppercase tracking-tight font-heading">
                            {tkt.event_title}
                          </h4>
                          <p className="text-xs text-zinc-400 mt-0.5">{tkt.event_date}</p>
                          <div className="flex flex-wrap items-center gap-2 mt-2">
                            <span className="text-[10px] font-mono font-bold text-zinc-300 bg-[#111] px-2.5 py-0.5 rounded border border-[#2a2a2a]">
                              {tkt.code}
                            </span>
                            <span className="text-[10px] text-zinc-400 font-semibold">
                              Lote: {tkt.batch_name}
                            </span>
                            {tkt.status === 'paid' ? (
                              <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Confirmado
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold text-amber-400 bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <Clock className="w-3 h-3" /> Pendente
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          onSelectTicket(tkt);
                          onNavigate('digital_ticket');
                        }}
                        className="bg-[#242424] hover:bg-[#FF1A2D] hover:text-white text-zinc-200 text-xs font-bold uppercase tracking-wider px-5 py-3 rounded-xl border border-[#333] hover:border-transparent transition flex items-center justify-center gap-2 shrink-0"
                      >
                        <span>Abrir QR Code</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: NOTIFICAÇÕES */}
          {activeTab === 'notifications' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8 space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222] pb-5">
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                    <Bell className="w-5 h-5 text-[#FF1A2D]" />
                    <span>Central de Notificações</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Avisos de ingressos, confirmações do Mercado Pago e novidades da PX CUSTON.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setNotifFilter('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      notifFilter === 'all'
                        ? 'bg-[#FF1A2D] text-white'
                        : 'bg-[#181818] text-zinc-400 hover:text-white'
                    }`}
                  >
                    Todas ({notifications.length})
                  </button>
                  <button
                    onClick={() => setNotifFilter('unread')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      notifFilter === 'unread'
                        ? 'bg-[#FF1A2D] text-white'
                        : 'bg-[#181818] text-zinc-400 hover:text-white'
                    }`}
                  >
                    Não lidas ({unreadCount})
                  </button>
                  {unreadCount > 0 && (
                    <button
                      onClick={handleMarkAllNotifsRead}
                      className="text-xs text-zinc-400 hover:text-white underline ml-2"
                    >
                      Marcar todas como lidas
                    </button>
                  )}
                </div>
              </div>

              {filteredNotifs.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-[#262626] rounded-2xl p-6">
                  <div className="w-14 h-14 rounded-2xl bg-[#181818] border border-[#333] flex items-center justify-center mx-auto mb-3 text-zinc-400">
                    <Bell className="w-7 h-7 text-[#FF1A2D]" />
                  </div>
                  <h3 className="text-sm font-bold text-white uppercase">Nenhuma Notificação</h3>
                  <p className="text-xs text-zinc-400 max-w-sm mx-auto mt-1">
                    Você está em dia com todas as atualizações e alertas da sua conta.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredNotifs.map((notif) => (
                    <div
                      key={notif.id}
                      onClick={() => handleToggleNotifRead(notif.id)}
                      className={`p-4 rounded-2xl border transition cursor-pointer flex items-start gap-3.5 ${
                        notif.read
                          ? 'bg-[#141414] border-[#222] opacity-75 hover:opacity-100'
                          : 'bg-[#181818] border-[#FF1A2D]/30 shadow-[0_0_15px_rgba(255,26,45,0.08)]'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                          notif.type === 'payment'
                            ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/30'
                            : notif.type === 'ticket'
                            ? 'bg-[#FF1A2D]/20 text-[#FF1A2D] border border-[#FF1A2D]/40'
                            : 'bg-blue-950/60 text-blue-400 border border-blue-500/30'
                        }`}
                      >
                        {notif.type === 'payment' && <CreditCard className="w-5 h-5" />}
                        {notif.type === 'ticket' && <TicketIcon className="w-5 h-5" />}
                        {notif.type === 'event' && <Calendar className="w-5 h-5" />}
                        {notif.type === 'system' && <AlertCircle className="w-5 h-5" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-xs font-bold text-white flex items-center gap-2">
                            <span>{notif.title}</span>
                            {!notif.read && (
                              <span className="w-2 h-2 rounded-full bg-[#FF1A2D] inline-block shrink-0" />
                            )}
                          </h4>
                          <span className="text-[10px] text-zinc-500 font-mono shrink-0">
                            {new Date(notif.created_at).toLocaleDateString('pt-BR')}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-300 mt-1 leading-relaxed">{notif.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Widget Inferior: Ingressos Recentes (visível na aba Perfil para manter integridade visual) */}
          {activeTab === 'profile' && (
            <div className="bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-black uppercase tracking-tight text-white font-heading">
                  Meus Ingressos Recentes
                </h3>
                <button
                  onClick={() => setActiveTab('tickets')}
                  className="text-xs text-[#FF1A2D] font-bold hover:underline"
                >
                  Ver Todos →
                </button>
              </div>

              {tickets.length === 0 ? (
                <p className="text-xs text-zinc-400">
                  Você ainda não possui ingressos emitidos nesta conta.
                </p>
              ) : (
                <div className="space-y-3">
                  {tickets.slice(0, 3).map((tkt) => (
                    <div
                      key={tkt.id}
                      className="bg-[#181818] border border-[#262626] hover:border-[#333] p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-[#222] flex items-center justify-center text-[#FF1A2D] shrink-0 border border-[#333]">
                          <TicketIcon className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-white uppercase">{tkt.event_title}</h4>
                          <p className="text-xs text-zinc-400 mt-0.5">{tkt.event_date}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] font-mono text-zinc-400 bg-[#111] px-2 py-0.5 rounded border border-[#222]">
                              {tkt.code}
                            </span>
                            {tkt.status === 'paid' ? (
                              <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Confirmado
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold text-amber-400 bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <Clock className="w-3 h-3" /> Pendente
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          onSelectTicket(tkt);
                          onNavigate('digital_ticket');
                        }}
                        className="bg-[#242424] hover:bg-[#FF1A2D] hover:text-white text-zinc-200 text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl border border-[#333] hover:border-transparent transition flex items-center justify-center gap-1.5"
                      >
                        <span>Ver Ingresso</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
