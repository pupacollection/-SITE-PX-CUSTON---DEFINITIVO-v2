import React, { useState } from 'react';
import {
  ActiveScreen,
  EventItem,
  Ticket,
  TicketBatch,
  UserProfile,
  MercadoPagoConfig,
} from './types';
import {
  INITIAL_EVENTS,
  INITIAL_USER,
  INITIAL_TICKETS,
  INITIAL_MERCADO_PAGO_CONFIG,
} from './data/initialData';
import { Header } from './components/common/Header';
import { Footer } from './components/common/Footer';
import { BottomNav } from './components/common/BottomNav';
import { PWAInstallPrompt } from './components/common/PWAInstallPrompt';
import { OfflineBanner } from './components/common/OfflineBanner';
import { supabase, getCurrentUserProfile, signOutUser } from './lib/supabase';

// Views
import { HomeView } from './views/HomeView';
import { MobileAppView } from './views/MobileAppView';
import { EventsCatalogView } from './views/EventsCatalogView';
import { EventDetailView } from './views/EventDetailView';
import { AuthView } from './views/AuthView';
import { ProfileView } from './views/ProfileView';
import { CheckoutView } from './views/CheckoutView';
import { DigitalTicketView } from './views/DigitalTicketView';
import { CheckinView } from './views/CheckinView';
import { AdminDashboardView } from './views/AdminDashboardView';
import { PaymentSettingsView } from './views/PaymentSettingsView';
import { CacheMaintenanceView } from './views/CacheMaintenanceView';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<ActiveScreen>('home');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [events, setEvents] = useState<EventItem[]>(INITIAL_EVENTS);
  const [selectedEvent, setSelectedEvent] = useState<EventItem>(INITIAL_EVENTS[0]);
  const [selectedBatches, setSelectedBatches] = useState<{ batch: TicketBatch; quantity: number }[]>([
    { batch: INITIAL_EVENTS[0].ticket_batches[0], quantity: 2 },
  ]);
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(INITIAL_TICKETS[0]);
  const [mercadoPagoConfig, setMercadoPagoConfig] = useState<MercadoPagoConfig>(INITIAL_MERCADO_PAGO_CONFIG);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Sincronização em tempo real com Supabase Auth
  React.useEffect(() => {
    // 1. Obter sessão atual do Supabase
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        getCurrentUserProfile(session.user).then((profile) => {
          setUser(profile);
        });
      } else {
        setUser(null);
      }
    });

    // 2. Ouvir mudanças de autenticação (LOGIN, LOGOUT, TOKEN_REFRESHED)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        const profile = await getCurrentUserProfile(session.user);
        setUser(profile);
      } else {
        // Se deslogou, remove o usuário
        setUser(null);
      }
    });

    // 3. Consultar eventos da API oficial / Supabase
    fetch('/api/events')
      .then((res) => res.json())
      .then((data) => {
        if (data.events && Array.isArray(data.events) && data.events.length > 0) {
          // Se vier do banco com estrutura completa, mesclar
          if (data.source === 'supabase') {
            setEvents(data.events);
          }
        }
      })
      .catch((err) => console.warn('[PX CUSTON] Erro ao sincronizar eventos:', err));

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Navigation handlers
  const handleNavigate = (screen: ActiveScreen) => {
    setCurrentScreen(screen);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectEvent = (event: EventItem) => {
    setSelectedEvent(event);
    setSelectedBatches([
      { batch: event.ticket_batches[0], quantity: 2 },
    ]);
    setCurrentScreen('event_detail');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleProceedToCheckout = (
    event: EventItem,
    batches: { batch: TicketBatch; quantity: number }[]
  ) => {
    setSelectedEvent(event);
    setSelectedBatches(batches);
    setCurrentScreen('checkout');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCheckoutSuccess = (newTickets: Ticket[]) => {
    setTickets((prev) => [...newTickets, ...prev]);
    setSelectedTicket(newTickets[0]);
    setCurrentScreen('digital_ticket');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleUpdateProfile = (updated: Partial<UserProfile>) => {
    if (user) {
      setUser({ ...user, ...updated });
    }
  };

  const handleLogout = async () => {
    try {
      await signOutUser();
    } catch (e) {
      console.warn('Erro ao deslogar do Supabase:', e);
    }
    setUser(null);
    setCurrentScreen('home');
  };

  // Check if current screen is admin or standalone to conditionally adapt footer/header
  const isDedicatedAdmin = currentScreen === 'admin_dashboard';

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col font-sans selection:bg-[#FF1A2D] selection:text-white">
      {/* Network offline warning */}
      <OfflineBanner />

      {/* PWA Install Button & iOS guide */}
      <PWAInstallPrompt />

      {/* Header bar (shown on all views except full admin dashboard which has dedicated sidebar) */}
      {!isDedicatedAdmin && (
        <Header
          currentScreen={currentScreen}
          onNavigate={handleNavigate}
          user={user}
          onOpenAuth={() => setAuthModalOpen(true)}
          onLogout={handleLogout}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1">
        {currentScreen === 'home' && (
          <HomeView
            events={events}
            onSelectEvent={handleSelectEvent}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'mobile_app' && (
          <MobileAppView
            events={events}
            user={user}
            onSelectEvent={handleSelectEvent}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'events' && (
          <EventsCatalogView
            events={events}
            onSelectEvent={handleSelectEvent}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'event_detail' && (
          <EventDetailView
            event={selectedEvent}
            onBack={() => handleNavigate('events')}
            onProceedToCheckout={handleProceedToCheckout}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'auth' && (
          <AuthView
            onSuccess={(loggedUser) => {
              setUser(loggedUser);
              handleNavigate('profile');
            }}
            onCancel={() => handleNavigate('home')}
          />
        )}

        {currentScreen === 'profile' && user && (
          <ProfileView
            user={user}
            tickets={tickets}
            onUpdateProfile={handleUpdateProfile}
            onSelectTicket={(tkt) => {
              setSelectedTicket(tkt);
              handleNavigate('digital_ticket');
            }}
            onNavigate={handleNavigate}
            onLogout={handleLogout}
          />
        )}

        {currentScreen === 'checkout' && (
          <CheckoutView
            event={selectedEvent}
            selectedBatches={selectedBatches}
            user={user}
            onSuccess={handleCheckoutSuccess}
            onCancel={() => handleNavigate('event_detail')}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'digital_ticket' && (
          <DigitalTicketView
            tickets={tickets}
            selectedTicket={selectedTicket}
            onNavigate={handleNavigate}
          />
        )}

        {currentScreen === 'checkin' && (
          !user || !['CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role) ? (
            <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-950/40 border border-[#FF1A2D]/30 flex items-center justify-center mb-4 text-[#FF1A2D] font-bold text-2xl">
                !
              </div>
              <h2 className="text-xl font-bold font-heading mb-2">Acesso Restrito a Operadores</h2>
              <p className="text-zinc-400 text-sm max-w-md mb-6">
                A tela PX CHECK-IN é restrita a operadores credenciados e administradores da PX CUSTON. Faça login com uma conta autorizada para validar ingressos.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setAuthModalOpen(true)}
                  className="px-5 py-2.5 bg-[#FF1A2D] text-white font-bold text-xs uppercase tracking-wider rounded-xl hover:bg-[#e01426] transition"
                >
                  Fazer Login
                </button>
                <button
                  onClick={() => handleNavigate('home')}
                  className="px-5 py-2.5 bg-[#181818] border border-[#2a2a2a] text-zinc-300 font-semibold text-xs rounded-xl hover:text-white hover:bg-[#222222] transition"
                >
                  Voltar ao Início
                </button>
              </div>
            </div>
          ) : (
            <CheckinView
              tickets={tickets}
              onNavigate={handleNavigate}
            />
          )
        )}

        {['admin_dashboard', 'admin_payments', 'admin_cache'].includes(currentScreen) && (
          !user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role) ? (
            <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-950/40 border border-[#FF1A2D]/30 flex items-center justify-center mb-4 text-[#FF1A2D] font-bold text-2xl">
                🔒
              </div>
              <h2 className="text-xl font-bold font-heading mb-2">Painel Restrito — PX CONTROL</h2>
              <p className="text-zinc-400 text-sm max-w-md mb-6">
                Esta área é exclusiva para a equipe autorizada e administradores da PX CUSTON. Por favor, acesse com uma conta com papel ADMIN ou SUPER_ADMIN.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setAuthModalOpen(true)}
                  className="px-5 py-2.5 bg-[#FF1A2D] text-white font-bold text-xs uppercase tracking-wider rounded-xl hover:bg-[#e01426] transition"
                >
                  Entrar como Administrador
                </button>
                <button
                  onClick={() => handleNavigate('home')}
                  className="px-5 py-2.5 bg-[#181818] border border-[#2a2a2a] text-zinc-300 font-semibold text-xs rounded-xl hover:text-white hover:bg-[#222222] transition"
                >
                  Voltar ao Início
                </button>
              </div>
            </div>
          ) : (
            <>
              {currentScreen === 'admin_dashboard' && (
                <AdminDashboardView
                  events={events}
                  onNavigate={handleNavigate}
                />
              )}
              {currentScreen === 'admin_payments' && (
                <PaymentSettingsView
                  initialConfig={mercadoPagoConfig}
                  onSave={(cfg) => setMercadoPagoConfig(cfg)}
                  onNavigate={handleNavigate}
                />
              )}
              {currentScreen === 'admin_cache' && (
                <CacheMaintenanceView
                  onNavigate={handleNavigate}
                />
              )}
            </>
          )
        )}
      </main>

      {/* Floating Auth Modal when triggered via header */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md">
            <AuthView
              onSuccess={(loggedUser) => {
                setUser(loggedUser);
                setAuthModalOpen(false);
              }}
              onCancel={() => setAuthModalOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Bottom Nav for mobile screens */}
      {!isDedicatedAdmin && (
        <BottomNav
          currentScreen={currentScreen}
          onNavigate={handleNavigate}
          isOperator={user?.role === 'CHECKIN_OPERATOR' || user?.role === 'SUPER_ADMIN'}
        />
      )}

      {/* Footer with official Pupa Labs credit and brand links */}
      {!isDedicatedAdmin && <Footer onNavigate={handleNavigate} />}
    </div>
  );
}
