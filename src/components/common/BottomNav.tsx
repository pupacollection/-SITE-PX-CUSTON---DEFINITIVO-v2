import React from 'react';
import { ActiveScreen } from '../../types';
import { Home, Calendar, Ticket, User, QrCode } from 'lucide-react';

interface BottomNavProps {
  currentScreen: ActiveScreen;
  onNavigate: (screen: ActiveScreen) => void;
  isOperator?: boolean;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  currentScreen,
  onNavigate,
  isOperator = false,
}) => {
  return (
    <nav
      aria-label="Navegação inferior mobile"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0c0c0c]/95 backdrop-blur-lg border-t border-[#1c1c1c] px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center justify-around"
    >
      <button
        type="button"
        onClick={() => onNavigate('home')}
        aria-current={currentScreen === 'home' ? 'page' : undefined}
        className={`flex flex-col items-center justify-center flex-1 min-w-0 py-1 transition ${
          currentScreen === 'home' ? 'text-[#FF1A2D]' : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <Home className="w-5 h-5 mb-0.5 shrink-0" />
        <span className="text-[10px] font-semibold truncate">Início</span>
      </button>

      <button
        type="button"
        onClick={() => onNavigate('events')}
        aria-current={currentScreen === 'events' || currentScreen === 'event_detail' ? 'page' : undefined}
        className={`flex flex-col items-center justify-center flex-1 min-w-0 py-1 transition ${
          currentScreen === 'events' || currentScreen === 'event_detail'
            ? 'text-[#FF1A2D]'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <Calendar className="w-5 h-5 mb-0.5 shrink-0" />
        <span className="text-[10px] font-semibold truncate">Eventos</span>
      </button>

      {/* Floating Check-in Shortcut for Operators */}
      {isOperator && (
        <button
          type="button"
          onClick={() => onNavigate('checkin')}
          aria-current={currentScreen === 'checkin' ? 'page' : undefined}
          className={`flex flex-col items-center justify-center -mt-5 px-1 shrink-0 transition ${
            currentScreen === 'checkin' ? 'scale-105' : ''
          }`}
        >
          <div className="w-12 h-12 rounded-full bg-[#FF1A2D] text-white flex items-center justify-center shadow-[0_0_15px_rgba(255,26,45,0.6)] border-2 border-[#0c0c0c]">
            <QrCode className="w-6 h-6" />
          </div>
          <span className="text-[9px] font-bold text-[#FF1A2D] mt-0.5 whitespace-nowrap">Check-in</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => onNavigate('digital_ticket')}
        aria-current={currentScreen === 'digital_ticket' ? 'page' : undefined}
        className={`flex flex-col items-center justify-center flex-1 min-w-0 py-1 transition ${
          currentScreen === 'digital_ticket' ? 'text-[#FF1A2D]' : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <Ticket className="w-5 h-5 mb-0.5 shrink-0" />
        <span className="text-[10px] font-semibold truncate">Ingressos</span>
      </button>

      <button
        type="button"
        onClick={() => onNavigate('profile')}
        aria-current={currentScreen === 'profile' || currentScreen === 'auth' ? 'page' : undefined}
        className={`flex flex-col items-center justify-center flex-1 min-w-0 py-1 transition ${
          currentScreen === 'profile' || currentScreen === 'auth'
            ? 'text-[#FF1A2D]'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <User className="w-5 h-5 mb-0.5 shrink-0" />
        <span className="text-[10px] font-semibold truncate">Perfil</span>
      </button>
    </nav>
  );
};
