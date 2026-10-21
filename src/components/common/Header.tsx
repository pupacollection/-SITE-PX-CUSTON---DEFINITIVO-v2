import React, { useState } from 'react';
import { PxLogo } from './PxLogo';
import { ActiveScreen, UserProfile } from '../../types';
import {
  Search,
  Shield,
  Smartphone,
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
}) => {
  const [screensDropdownOpen, setScreensDropdownOpen] = useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const { isInstallable, install } = usePWAInstall();
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setScreensDropdownOpen(false);
      }
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setScreensDropdownOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleNav = (screen: ActiveScreen) => {
    onNavigate(screen);
    setScreensDropdownOpen(false);
  };

  return (
    <header className="sticky top-0 z-40 bg-[#000000]/95 backdrop-blur-md border-b border-[#1c1c1c] transition-all">
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between gap-1.5 sm:gap-4">
        {/* Logo PX CUSTON */}
        <button
          type="button"
          onClick={() => handleNav('home')}
          aria-label="PX CUSTON — Ir para o Início"
          className="cursor-pointer flex items-center gap-2 group py-1 shrink-0 focus:outline-none"
        >
          <PxLogo size="sm" className="sm:hidden" />
          <PxLogo size="md" className="hidden sm:inline-flex" />
        </button>

        {/* Desktop Navigation Links */}
        <nav
          aria-label="Navegação principal"
          className="hidden md:flex items-center gap-4 lg:gap-6 text-xs lg:text-sm font-medium min-w-0"
        >
          <button
            type="button"
            onClick={() => handleNav('home')}
            className={`whitespace-nowrap shrink-0 transition hover:text-white ${
              currentScreen === 'home' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            Início
          </button>
          <button
            type="button"
            onClick={() => handleNav('events')}
            className={`whitespace-nowrap shrink-0 transition hover:text-white ${
              currentScreen === 'events' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            Eventos
          </button>
          <button
            type="button"
            onClick={() => handleNav('mobile_app')}
            className={`flex items-center gap-1.5 whitespace-nowrap shrink-0 transition hover:text-white ${
              currentScreen === 'mobile_app' ? 'text-[#FF1A2D] font-semibold' : 'text-zinc-400'
            }`}
          >
            <Smartphone className="w-4 h-4 text-[#FF1A2D] shrink-0" />
            <span>Visão App / PWA</span>
          </button>

          {/* Menu de Homologação / Dev Screen Explorer (Exibido exclusivamente em ambiente de desenvolvimento) */}
          {isDev && (
            <div className="relative shrink-0" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setScreensDropdownOpen(!screensDropdownOpen)}
                aria-expanded={screensDropdownOpen}
                aria-label="Menu de telas em desenvolvimento"
                className="flex items-center gap-1.5 text-xs bg-[#141414] hover:bg-[#1f1f1f] border border-[#2a2a2a] text-zinc-300 px-2.5 lg:px-3 py-1.5 rounded-lg transition whitespace-nowrap"
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
                      type="button"
                      onClick={() => handleNav('home')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">01</span>
                      <span>Site Público — Home</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNav('mobile_app')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">02</span>
                      <span>App Mobile / PWA</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNav('auth')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">03</span>
                      <span>Login & Cadastro</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNav('profile')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">04</span>
                      <span>Perfil do Usuário</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNav('event_detail')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">05</span>
                      <span>Detalhe do Evento</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNav('checkout')}
                      className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                    >
                      <span className="w-5 text-[#FF1A2D] font-bold">06</span>
                      <span>Checkout Mercado Pago</span>
                    </button>
                    <button
                      type="button"
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
                        type="button"
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
                          type="button"
                          onClick={() => handleNav('admin_dashboard')}
                          className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2 text-white"
                        >
                          <span className="w-5 text-[#FF1A2D] font-bold">09</span>
                          <span className="font-semibold">PX CONTROL — Dashboard</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleNav('admin_payments')}
                          className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                        >
                          <span className="w-5 text-[#FF1A2D] font-bold">10</span>
                          <span>Configurações Mercado Pago</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleNav('admin_cache')}
                          className="w-full text-left px-3 py-2 hover:bg-[#1a1a1a] flex items-center gap-2"
                        >
                          <span className="w-5 text-[#FF1A2D] font-bold">11</span>
                          <span>Limpeza de Cache</span>
                        </button>
                      </>
                    )}
                    {(!user || !['ADMIN', 'SUPER_ADMIN', 'CHECKIN_OPERATOR'].includes(user.role)) && (
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
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          {/* In-app PWA install button */}
          {isInstallable && (
            <button
              type="button"
              onClick={install}
              className="hidden xl:flex items-center gap-1.5 bg-[#181818] hover:bg-[#222] border border-[#333] text-zinc-300 text-xs px-3 py-1.5 rounded-lg transition whitespace-nowrap shrink-0"
              title="Instalar App PX CUSTON"
              aria-label="Instalar App PX CUSTON"
            >
              <Smartphone className="w-3.5 h-3.5 text-[#FF1A2D] shrink-0" />
              <span>Instalar PWA</span>
            </button>
          )}

          {/* Search Button */}
          <button
            type="button"
            onClick={() => handleNav('events')}
            className="p-1.5 sm:p-2 text-zinc-400 hover:text-white hover:bg-[#161616] rounded-lg transition shrink-0"
            title="Pesquisar Eventos"
            aria-label="Pesquisar Eventos"
          >
            <Search className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>

          {/* User Profile or Login Button */}
          {user ? (
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Único Atalho Oficial PX CONTROL no Cabeçalho para Administradores */}
              {['ADMIN', 'SUPER_ADMIN'].includes(user.role) && (
                <button
                  type="button"
                  onClick={() => handleNav('admin_dashboard')}
                  className={`flex items-center gap-1 sm:gap-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider px-2 sm:px-3 py-1.5 rounded-lg border transition shrink-0 whitespace-nowrap ${
                    currentScreen === 'admin_dashboard'
                      ? 'bg-[#FF1A2D] border-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                      : 'bg-[#161616] border-[#FF1A2D]/50 text-[#FF1A2D] hover:bg-[#FF1A2D] hover:border-[#FF1A2D] hover:text-white shadow-[0_0_12px_rgba(255,26,45,0.2)]'
                  }`}
                  title="Acessar Painel PX CONTROL"
                  aria-label="Acessar Painel PX CONTROL"
                >
                  <Shield className="w-3.5 h-3.5 shrink-0" />
                  <span>PX CONTROL</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleNav('profile')}
                aria-label="Acessar Meu Perfil"
                title={user.full_name || 'Meu Perfil'}
                className="flex items-center gap-2 bg-[#141414] hover:bg-[#1e1e1e] border border-[#2a2a2a] p-1 lg:pl-2 lg:pr-3 lg:py-1.5 rounded-full transition shrink-0"
              >
                <div className="w-7 h-7 rounded-full bg-[#FF1A2D] text-white font-bold text-xs flex items-center justify-center shrink-0">
                  {user.full_name ? user.full_name.charAt(0).toUpperCase() : 'U'}
                </div>
                <div className="text-left hidden lg:block max-w-[140px]">
                  <p className="text-xs font-semibold text-white leading-tight truncate">{user.full_name}</p>
                  <p className="text-[10px] text-zinc-400 leading-tight truncate">
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
              type="button"
              onClick={onOpenAuth}
              className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-[11px] sm:text-xs font-bold uppercase tracking-wider px-3 sm:px-5 py-1.5 sm:py-2 rounded-lg shadow-[0_0_15px_rgba(255,26,45,0.4)] transition transform hover:-translate-y-0.5 whitespace-nowrap shrink-0"
            >
              Entrar
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

