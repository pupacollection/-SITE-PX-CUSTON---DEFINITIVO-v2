import React, { useState } from 'react';
import { PxLogo } from './PxLogo';
import { ActiveScreen, UserProfile } from '../../types';
import {
  Menu,
  X,
  Search,
  User,
  Shield,
  QrCode,
  LayoutDashboard,
  Smartphone,
  CreditCard,
  Trash2,
  Ticket,
  ChevronDown,
} from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

interface HeaderProps {
  currentScreen: ActiveScreen;
  onNavigate: (screen: ActiveScreen) => void;
  user: UserProfile | null;
  onOpenAuth: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentScreen,
  onNavigate,
  user,
  onOpenAuth,
  onLogout,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [screensDropdownOpen, setScreensDropdownOpen] = useState(false);
  const { isInstallable, install } = usePWAInstall();
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
        setScreensDropdownOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNav = (screen: ActiveScreen) => {
    onNavigate(screen);
    setMobileMenuOpen(false);
    setScreensDropdownOpen(false);
  };

  return (
    <header className="sticky top-0 z-40 bg-[#000000]/95 backdrop-blur-md border-b border-[#1c1c1c] transition-all">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-between gap-4">
        {/* Logo PX CUSTON */}
        <div
          onClick={() => handleNav('home')}
          className="cursor-pointer flex items-center gap-2 group py-2"
        >
          <PxLogo size="md" />
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            onClick={() => handleNav('home')}
            className={`transition hover:text-white ${
              currentScreen === 'home' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            Início
          </button>
          <button
            onClick={() => handleNav('events')}
            className={`transition hover:text-white ${
              currentScreen === 'events' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            Eventos
          </button>
          <button
            onClick={() => handleNav('mobile_app')}
            className={`flex items-center gap-1.5 transition hover:text-white ${
              currentScreen === 'mobile_app' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            <Smartphone className="w-4 h-4 text-[#FF1A2D]" />
            Visão App / PWA
          </button>

          {/* Atalho Oficial PX CONTROL para Administradores */}
          {user && ['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
            <button
              onClick={() => handleNav('admin_dashboard')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition ${
                currentScreen === 'admin_dashboard'
                  ? 'bg-[#FF1A2D] border-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'bg-[#161616] border-[#333] text-[#FF1A2D] hover:bg-[#FF1A2D] hover:text-white font-bold'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>PX CONTROL</span>
            </button>
          )}

          {/* Menu de Homologação / Dev Screen Explorer (Exibido exclusivamente em ambiente de desenvolvimento) */}
          {isDev && (
            <div className="relative">
              <button
                onClick={() => setScreensDropdownOpen(!screensDropdownOpen)}
                aria-expanded={screensDropdownOpen}
                aria-label="Menu de telas em desenvolvimento"
                className="flex items-center gap-1.5 text-xs bg-[#141414] hover:bg-[#1f1f1f] border border-[#2a2a2a] text-zinc-300 px-3 py-1.5 rounded-lg transition"
              >
                <span className="font-mono text-[11px] text-amber-400">[DEV] Telas</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#FF1A2D]" />
              </button>

            {screensDropdownOpen && (
              <div className="absolute right-0 mt-2 w-72 bg-[#121212] border border-[#262626] rounded-xl shadow-2xl py-2 z-50 text-xs text-zinc-300 animate-fade-in divide-y divide-[#1e1e1e]">
                <div className="px-3 py-1.5 font-bold uppercase tracking-wider text-[10px] text-zinc-500">
                  Visão Pública & Cliente
                </div>
                <div className="py-1">
                  <button
                    onClick={() => handleNav('home')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">01</span>
                    <span>Site Público — Home</span>
                  </button>
                  <button
                    onClick={() => handleNav('mobile_app')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">02</span>
                    <span>App Mobile / PWA</span>
                  </button>
                  <button
                    onClick={() => handleNav('auth')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">03</span>
                    <span>Login & Cadastro</span>
                  </button>
                  <button
                    onClick={() => handleNav('profile')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">04</span>
                    <span>Perfil do Usuário</span>
                  </button>
                  <button
                    onClick={() => handleNav('event_detail')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">05</span>
                    <span>Detalhe do Evento</span>
                  </button>
                  <button
                    onClick={() => handleNav('checkout')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">06</span>
                    <span>Checkout Mercado Pago</span>
                  </button>
                  <button
                    onClick={() => handleNav('digital_ticket')}
                    className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                  >
                    <span className="w-5 text-[#FF1A2D] font-bold">07</span>
                    <span>Ingresso Digital (QR Code)</span>
                  </button>
                </div>

                <div className="px-3 py-1.5 font-bold uppercase tracking-wider text-[10px] text-zinc-500">
                  Operador & Gestão (PX CONTROL)
                </div>
                <div className="py-1">
                  {user && ['CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
                    <button
                      onClick={() => handleNav('checkin')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2 text-white"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">08</span>
                      <span className="font-semibold text-[#FF1A2D]">PX CHECK-IN (Operador)</span>
                    </button>
                  )}
                  {user && ['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
                    <>
                      <button
                        onClick={() => handleNav('admin_dashboard')}
                        className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2 text-white"
                      >
                        <span className="w-5 text-[#FF1A2D] font-bold">09</span>
                        <span className="font-semibold">PX CONTROL — Dashboard</span>
                      </button>
                      <button
                        onClick={() => handleNav('admin_payments')}
                        className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                      >
                        <span className="w-5 text-[#FF1A2D] font-bold">10</span>
                        <span>Configurações Mercado Pago</span>
                      </button>
                      <button
                        onClick={() => handleNav('admin_cache')}
                        className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                      >
                        <span className="w-5 text-[#FF1A2D] font-bold">11</span>
                        <span>Limpeza de Cache</span>
                      </button>
                    </>
                  )}
                  {(!user || (!['ADMIN', 'SUPER_ADMIN', 'CHECKIN_OPERATOR'].includes(user.role))) && (
                    <div className="px-3 py-2 text-[11px] text-zinc-500 italic">
                      Acesso restrito à equipe autorizada PX CUSTON.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </nav>

        {/* Right Action Icons & Profile / Login */}
        <div className="flex items-center gap-3">
          {/* In-app PWA install button */}
          {isInstallable && (
            <button
              onClick={install}
              className="hidden lg:flex items-center gap-1.5 bg-[#181818] hover:bg-[#222] border border-[#333] text-zinc-300 text-xs px-3 py-1.5 rounded-lg transition"
              title="Instalar App PX CUSTON"
            >
              <Smartphone className="w-3.5 h-3.5 text-[#FF1A2D]" />
              <span>Instalar PWA</span>
            </button>
          )}

          {/* Search Button */}
          <button
            onClick={() => handleNav('events')}
            className="p-2 text-zinc-400 hover:text-white hover:bg-[#161616] rounded-lg transition"
            title="Pesquisar Eventos"
          >
            <Search className="w-5 h-5" />
          </button>

          {/* User Profile or Login Button */}
          {user ? (
            <div className="flex items-center gap-2">
              {['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
                <button
                  onClick={() => handleNav('admin_dashboard')}
                  className="flex items-center gap-1.5 bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-[11px] sm:text-xs font-bold uppercase tracking-wider px-2.5 sm:px-3 py-1.5 rounded-lg shadow-[0_0_15px_rgba(255,26,45,0.4)] transition"
                  title="Acessar Painel PX CONTROL"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>PX CONTROL</span>
                </button>
              )}

              <button
                onClick={() => handleNav('profile')}
                className="flex items-center gap-2 bg-[#141414] hover:bg-[#1e1e1e] border border-[#2a2a2a] pl-2 pr-3 py-1.5 rounded-full transition"
              >
                <div className="w-7 h-7 rounded-full bg-[#FF1A2D] text-white font-bold text-xs flex items-center justify-center">
                  {user.full_name ? user.full_name.charAt(0).toUpperCase() : 'U'}
                </div>
                <div className="text-left hidden sm:block">
                  <p className="text-xs font-semibold text-white leading-tight">{user.full_name}</p>
                  <p className="text-[10px] text-zinc-400 leading-tight">
                    {user.role === 'SUPER_ADMIN'
                      ? 'Super Admin'
                      : user.role === 'ADMIN'
                      ? 'Administrador'
                      : user.role === 'CHECKIN_OPERATOR'
                      ? 'Operador'
                      : 'Cliente PX'}
                  </p>
                </div>
              </button>
            </div>
          ) : (
            <button
              onClick={onOpenAuth}
              className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-5 py-2 rounded-lg shadow-[0_0_15px_rgba(255,26,45,0.4)] transition transform hover:-translate-y-0.5"
            >
              Entrar
            </button>
          )}

          {/* Mobile Hamburger Menu Toggle */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? 'Fechar menu de navegação' : 'Abrir menu de navegação'}
            className="md:hidden p-2 text-zinc-400 hover:text-white hover:bg-[#161616] rounded-lg transition"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-[#0a0a0a] border-b border-[#222] px-4 pt-3 pb-6 space-y-3 animate-fade-in">
          {/* Acesso Oficial PX CONTROL para Administradores no Mobile */}
          {user && ['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
            <div className="p-3 bg-[#181112] border border-[#FF1A2D]/40 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#FF1A2D] uppercase flex items-center gap-1.5">
                  <Shield className="w-4 h-4" /> Painel PX CONTROL
                </span>
                <span className="text-[10px] bg-[#FF1A2D] text-white font-mono font-bold px-2 py-0.5 rounded">
                  {user.role === 'SUPER_ADMIN' ? 'SUPER ADMIN' : 'ADMIN'}
                </span>
              </div>
              <button
                onClick={() => handleNav('admin_dashboard')}
                className="w-full bg-[#FF1A2D] hover:bg-[#e00f21] text-white font-bold text-xs py-2 rounded-lg flex items-center justify-center gap-2 shadow-[0_0_12px_rgba(255,26,45,0.3)] transition"
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
                <span>Acessar Painel Administrativo</span>
              </button>
            </div>
          )}

          {/* Navegação Oficial Mobile */}
          <nav className="space-y-1 text-xs" aria-label="Navegação mobile">
            <button
              onClick={() => handleNav('home')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                currentScreen === 'home'
                  ? 'bg-[#181818] text-[#FF1A2D] font-bold border border-[#2a2a2a]'
                  : 'text-zinc-300 hover:text-white hover:bg-[#141414]'
              }`}
            >
              <span>Início</span>
            </button>

            <button
              onClick={() => handleNav('events')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                currentScreen === 'events' || currentScreen === 'event_detail'
                  ? 'bg-[#181818] text-[#FF1A2D] font-bold border border-[#2a2a2a]'
                  : 'text-zinc-300 hover:text-white hover:bg-[#141414]'
              }`}
            >
              <span>Eventos & Encontros</span>
            </button>

            <button
              onClick={() => handleNav('digital_ticket')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                currentScreen === 'digital_ticket'
                  ? 'bg-[#181818] text-[#FF1A2D] font-bold border border-[#2a2a2a]'
                  : 'text-zinc-300 hover:text-white hover:bg-[#141414]'
              }`}
            >
              <span>Meus Ingressos</span>
            </button>

            <button
              onClick={() => handleNav('mobile_app')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                currentScreen === 'mobile_app'
                  ? 'bg-[#181818] text-[#FF1A2D] font-bold border border-[#2a2a2a]'
                  : 'text-zinc-300 hover:text-white hover:bg-[#141414]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Smartphone className="w-3.5 h-3.5 text-[#FF1A2D]" />
                <span>Instalar Aplicativo PWA</span>
              </div>
            </button>

            <button
              onClick={() => handleNav('profile')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                currentScreen === 'profile'
                  ? 'bg-[#181818] text-[#FF1A2D] font-bold border border-[#2a2a2a]'
                  : 'text-zinc-300 hover:text-white hover:bg-[#141414]'
              }`}
            >
              <span>{user ? 'Meu Perfil' : 'Acessar Conta'}</span>
            </button>

            {user && ['CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
              <button
                onClick={() => handleNav('checkin')}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center justify-between transition ${
                  currentScreen === 'checkin'
                    ? 'bg-[#FF1A2D]/20 text-[#FF1A2D] font-bold border border-[#FF1A2D]/40'
                    : 'text-[#FF1A2D] bg-[#160c0d] border border-[#FF1A2D]/20 hover:bg-[#FF1A2D]/10'
                }`}
              >
                <div className="flex items-center gap-2">
                  <QrCode className="w-3.5 h-3.5 text-[#FF1A2D]" />
                  <span>PX Check-in (Portaria)</span>
                </div>
              </button>
            )}
          </nav>

          <div className="pt-2 border-t border-[#1f1f1f] flex items-center justify-between">
            {user ? (
              <button
                onClick={onLogout}
                className="text-xs text-red-400 hover:text-red-300 py-1"
              >
                Sair da Conta ({user.email})
              </button>
            ) : (
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenAuth();
                }}
                className="w-full bg-[#FF1A2D] py-2.5 rounded-lg text-xs font-bold uppercase text-white"
              >
                Acessar Conta
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
