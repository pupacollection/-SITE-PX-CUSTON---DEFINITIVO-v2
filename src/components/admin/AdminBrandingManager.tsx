import React, { useState, useEffect, useRef } from 'react';
import {
  Smartphone,
  Upload,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Save,
  Eye,
  Info,
  ShieldCheck,
  Sparkles,
  Layers,
  Palette,
} from 'lucide-react';
import { PwaBrandingConfig } from '../../types';
import {
  getPwaBranding,
  processPwaIcon,
  savePwaBranding,
  resetPwaBranding,
  applyDynamicPwaIcons,
  ProcessedIcons,
} from '../../services/brandingService';

export const AdminBrandingManager: React.FC = () => {
  const [currentBranding, setCurrentBranding] = useState<PwaBrandingConfig | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Upload & Processed states
  const [processedIcons, setProcessedIcons] = useState<ProcessedIcons | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState<string>('#000000');
  const [previewShape, setPreviewShape] = useState<'squircle' | 'circle' | 'square'>('squircle');
  const [showSafeZoneOverlay, setShowSafeZoneOverlay] = useState<boolean>(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Carregar configurações atuais de branding
  const loadBranding = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getPwaBranding();
      setCurrentBranding(data);
    } catch (err: any) {
      setError(err.message || 'Falha ao consultar configurações de ícone do PWA.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBranding();
  }, []);

  // Tratar seleção de arquivo
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setSuccessMessage(null);
    setSelectedFileName(file.name);

    try {
      const processed = await processPwaIcon(file, bgColor);
      setProcessedIcons(processed);
    } catch (err: any) {
      setError(err.message || 'Falha ao processar arquivo de imagem.');
      setProcessedIcons(null);
    }
  };

  // Re-processar se a cor de fundo mudar
  const handleBgColorChange = async (color: string) => {
    setBgColor(color);
    if (fileInputRef.current?.files?.[0]) {
      try {
        const processed = await processPwaIcon(fileInputRef.current.files[0], color);
        setProcessedIcons(processed);
      } catch (err: any) {
        setError(err.message || 'Falha ao reprocessar com a nova cor de fundo.');
      }
    }
  };

  // Salvar alterações no servidor
  const handleSave = async () => {
    if (!processedIcons) return;

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const updated = await savePwaBranding({
        icon_192: processedIcons.icon_192,
        icon_512: processedIcons.icon_512,
        icon_maskable: processedIcons.icon_maskable,
      });

      setCurrentBranding(updated);
      applyDynamicPwaIcons(updated);
      setSuccessMessage('Ícone PWA atualizado com sucesso! O novo ícone foi aplicado ao manifesto e navegador.');
      setProcessedIcons(null);
      setSelectedFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: any) {
      setError(err.message || 'Erro ao salvar novo ícone PWA.');
    } finally {
      setSaving(false);
    }
  };

  // Restaurar ícone oficial PX CUSTON
  const handleReset = async () => {
    if (!window.confirm('Tem certeza de que deseja restaurar o ícone oficial da PX CUSTON?')) {
      return;
    }

    setResetting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const reset = await resetPwaBranding();
      setCurrentBranding(reset);
      applyDynamicPwaIcons(reset);
      setSuccessMessage('Ícone oficial PX CUSTON restaurado com sucesso!');
      setProcessedIcons(null);
      setSelectedFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: any) {
      setError(err.message || 'Erro ao restaurar ícone padrão.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho da Seção */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
        <div>
          <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2">
            <Palette className="w-6 h-6 text-[#FF1A2D]" />
            Identidade Visual & Ícone PWA
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Personalize o ícone do aplicativo PWA para smartphones Android, iPhones e navegadores desktop sem necessidade de rebuild.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {currentBranding?.is_custom && (
            <button
              onClick={handleReset}
              disabled={resetting || saving}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#181818] border border-[#2a2a2a] text-zinc-300 hover:text-white hover:bg-[#202020] transition flex items-center gap-2 disabled:opacity-50"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${resetting ? 'animate-spin' : ''}`} />
              <span>Restaurar Oficial</span>
            </button>
          )}
          <button
            onClick={loadBranding}
            disabled={loading}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#141414] border border-[#222] text-zinc-400 hover:text-white transition flex items-center gap-1.5"
          >
            <RotateCcw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {/* Feedback Alerts */}
      {successMessage && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-3">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Card de Status Atual */}
      <div className="bg-[#121212] border border-[#222] rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-black border border-[#2a2a2a] p-2 flex items-center justify-center shrink-0 overflow-hidden shadow-lg">
              <img
                src={currentBranding?.icon_192 || '/px-logo-192.png'}
                alt="Ícone PWA Ativo"
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '/px-logo-192.png';
                }}
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white uppercase tracking-wider font-heading">
                  Status Atual do Aplicativo
                </span>
                {currentBranding?.is_custom ? (
                  <span className="text-[10px] bg-red-500/20 text-[#FF1A2D] border border-[#FF1A2D]/30 px-2 py-0.5 rounded-full font-semibold">
                    Ícone Personalizado Ativo
                  </span>
                ) : (
                  <span className="text-[10px] bg-zinc-800 text-zinc-300 border border-zinc-700 px-2 py-0.5 rounded-full font-semibold">
                    Logotipo Oficial Padrão
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                {currentBranding?.is_custom && currentBranding.updated_at
                  ? `Última atualização em ${new Date(currentBranding.updated_at).toLocaleString('pt-BR')}`
                  : 'Utilizando o logotipo padrão oficial de alta resolução da PX CUSTON.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400 bg-[#181818] px-3 py-2 rounded-xl border border-[#262626]">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Validação Autoritativa: ADMIN / SUPER_ADMIN</span>
          </div>
        </div>
      </div>

      {/* Formulário de Upload e Processamento */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Painel de Upload (Esquerda - 6 cols) */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-[#121212] border border-[#222] rounded-2xl p-6 space-y-5">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-heading flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#FF1A2D]" />
              Enviar Nova Imagem de Ícone
            </h3>

            {/* Caixa de Upload Drag & Drop */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[#2b2b2b] hover:border-[#FF1A2D]/60 hover:bg-[#161616] rounded-2xl p-6 text-center cursor-pointer transition space-y-3 group"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="w-12 h-12 rounded-xl bg-[#1c1c1c] group-hover:bg-[#FF1A2D]/10 flex items-center justify-center mx-auto transition">
                <Upload className="w-6 h-6 text-zinc-400 group-hover:text-[#FF1A2D] transition" />
              </div>
              <div>
                <p className="text-xs font-semibold text-white">
                  {selectedFileName ? selectedFileName : 'Clique ou arraste a imagem do ícone'}
                </p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Formatos aceitos: PNG, JPG, JPEG ou WEBP (máx. 2.0MB).
                </p>
                <p className="text-[10px] text-zinc-600">
                  Recomendado: imagem quadrada de pelo menos 512x512 pixels com fundo transparente ou escuro.
                </p>
              </div>
            </div>

            {/* Seletor de Fundo do Canvas */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300 block">
                Cor de Fundo da Moldura (Safe Zone / Splash)
              </label>
              <div className="flex items-center gap-3">
                {[
                  { name: 'Preto Puro (#000000)', value: '#000000' },
                  { name: 'Grafite Escuro (#0D0D0D)', value: '#0D0D0D' },
                  { name: 'Cinza Asfalto (#141414)', value: '#141414' },
                  { name: 'Vermelho PX (#FF1A2D)', value: '#FF1A2D' },
                ].map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => handleBgColorChange(c.value)}
                    className={`w-7 h-7 rounded-lg border-2 transition ${
                      bgColor === c.value ? 'border-white scale-110 shadow-md' : 'border-[#333]'
                    }`}
                    style={{ backgroundColor: c.value }}
                    title={c.name}
                  />
                ))}
                <span className="text-[11px] font-mono text-zinc-400 ml-2">{bgColor}</span>
              </div>
            </div>

            {/* Dicas e Instruções da W3C / PWA */}
            <div className="bg-[#161616] border border-[#222] rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
                <Info className="w-3.5 h-3.5 text-[#FF1A2D]" />
                <span>Geração Automática Multi-Resolução</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Ao selecionar a imagem, o sistema gera instantaneamente em seu navegador:
              </p>
              <ul className="text-[10px] text-zinc-500 space-y-1 list-disc list-inside">
                <li><strong>192x192 PNG:</strong> Tela inicial de smartphones e menu de apps.</li>
                <li><strong>512x512 PNG:</strong> Tela de abertura (Splash Screen) e tablets.</li>
                <li><strong>512x512 Maskable:</strong> Ícone adaptativo do Android com margem de segurança de 80% (Safe Zone).</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Pré-visualização em Tempo Real (Direita - 6 cols) */}
        <div className="lg:col-span-6 space-y-6">
          <div className="bg-[#121212] border border-[#222] rounded-2xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider font-heading flex items-center gap-2">
                <Eye className="w-4 h-4 text-[#FF1A2D]" />
                Simulador da Tela Inicial
              </h3>

              {/* Botões de Forma de Visualização */}
              <div className="flex items-center gap-1 bg-[#1a1a1a] p-1 rounded-lg border border-[#262626]">
                <button
                  type="button"
                  onClick={() => setPreviewShape('squircle')}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                    previewShape === 'squircle' ? 'bg-[#FF1A2D] text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Squircle (iOS)
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewShape('circle')}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                    previewShape === 'circle' ? 'bg-[#FF1A2D] text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Círculo (Android)
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewShape('square')}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                    previewShape === 'square' ? 'bg-[#FF1A2D] text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Quadrado
                </button>
              </div>
            </div>

            {/* Mockup de Celular */}
            <div className="bg-gradient-to-b from-[#181818] to-[#0f0f0f] border border-[#262626] rounded-2xl p-6 flex flex-col items-center justify-center space-y-4">
              <div className="text-center">
                <span className="text-[11px] text-zinc-500 uppercase tracking-widest font-mono">
                  {processedIcons ? 'Prévia do Novo Ícone' : 'Ícone Atual em Uso'}
                </span>
              </div>

              {/* Ícone com corte adaptativo simulado */}
              <div className="relative group">
                <div
                  className={`w-24 h-24 flex items-center justify-center overflow-hidden shadow-2xl transition-all duration-300 border border-[#333] ${
                    previewShape === 'circle'
                      ? 'rounded-full'
                      : previewShape === 'squircle'
                      ? 'rounded-[26px]'
                      : 'rounded-xl'
                  }`}
                  style={{ backgroundColor: bgColor }}
                >
                  <img
                    src={
                      processedIcons
                        ? previewShape === 'circle'
                          ? processedIcons.icon_maskable
                          : processedIcons.icon_192
                        : currentBranding?.icon_192 || '/px-logo-192.png'
                    }
                    alt="Prévia Ícone"
                    className="w-full h-full object-contain"
                  />
                </div>

                {/* Overlay de Safe Zone para Maskable */}
                {previewShape === 'circle' && showSafeZoneOverlay && processedIcons && (
                  <div className="absolute inset-0 rounded-full border-2 border-dashed border-[#FF1A2D]/50 pointer-events-none flex items-center justify-center">
                    <span className="text-[8px] text-[#FF1A2D] bg-black/70 px-1 rounded font-mono">
                      Safe Zone (80%)
                    </span>
                  </div>
                )}
              </div>

              <div className="text-center space-y-0.5">
                <p className="text-xs font-bold text-white tracking-wide">PX CUSTON</p>
                <p className="text-[10px] text-zinc-500 font-mono">app.pxcuston.com.br</p>
              </div>

              {processedIcons && previewShape === 'circle' && (
                <button
                  type="button"
                  onClick={() => setShowSafeZoneOverlay(!showSafeZoneOverlay)}
                  className="text-[10px] text-zinc-400 hover:text-white underline pt-1"
                >
                  {showSafeZoneOverlay ? 'Ocultar guia Safe Zone' : 'Exibir guia Safe Zone'}
                </button>
              )}
            </div>

            {/* Comparativo de Resoluções Processadas */}
            {processedIcons && (
              <div className="space-y-2">
                <span className="text-[11px] font-semibold text-zinc-400 block">
                  Resoluções geradas prontas para salvar:
                </span>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-[#181818] border border-[#262626] p-2.5 rounded-xl text-center space-y-1">
                    <span className="text-[10px] text-zinc-400 block font-mono">192x192 (Any)</span>
                    <img
                      src={processedIcons.icon_192}
                      alt="192x192"
                      className="w-8 h-8 mx-auto rounded object-contain border border-[#333]"
                    />
                  </div>
                  <div className="bg-[#181818] border border-[#262626] p-2.5 rounded-xl text-center space-y-1">
                    <span className="text-[10px] text-zinc-400 block font-mono">512x512 (Splash)</span>
                    <img
                      src={processedIcons.icon_512}
                      alt="512x512"
                      className="w-8 h-8 mx-auto rounded object-contain border border-[#333]"
                    />
                  </div>
                  <div className="bg-[#181818] border border-[#262626] p-2.5 rounded-xl text-center space-y-1">
                    <span className="text-[10px] text-zinc-400 block font-mono">512x512 (Maskable)</span>
                    <img
                      src={processedIcons.icon_maskable}
                      alt="Maskable"
                      className="w-8 h-8 mx-auto rounded-full object-contain border border-[#333]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Botão de Salvar Alterações */}
            {processedIcons && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full py-3 px-4 rounded-xl font-bold text-xs uppercase tracking-wider bg-[#FF1A2D] hover:bg-[#d91425] text-white shadow-[0_0_20px_rgba(255,26,45,0.4)] flex items-center justify-center gap-2 transition disabled:opacity-50"
                >
                  <Save className={`w-4 h-4 ${saving ? 'animate-spin' : ''}`} />
                  <span>{saving ? 'Publicando Ícones no PWA...' : 'Salvar e Atualizar Ícone do PWA'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
