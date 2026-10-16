import zlib from 'zlib';

export interface PngValidationSuccess {
  valid: true;
  buffer: Buffer;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  uncompressedBytes: number;
}

export interface PngValidationFailure {
  valid: false;
  error: string;
}

export type PngValidationResult = PngValidationSuccess | PngValidationFailure;

/**
 * Validação criptográfica e estrutural profunda de arquivo PNG (RFC 2083 / W3C PNG Specification):
 * 1. Valida estrutura Data URL e formato Base64.
 * 2. Valida tipo MIME estrito (image/png).
 * 3. Valida tamanho de buffer (mínimo de 45 bytes para caber assinatura, IHDR e IEND; máximo 2.5MB por ícone).
 * 4. Valida Magic Bytes oficiais do padrão PNG (89 50 4E 47 0D 0A 1A 0A).
 * 5. Valida que o PRIMEIRO chunk é estritamente IHDR (comprimento exato de 13 bytes).
 * 6. Valida parâmetros da imagem em IHDR: bitDepth, colorType, compressionMethod (0), filterMethod (0).
 * 7. Varre todos os chunks validando limites de memória, ausência de truncamento e CRC32 individual.
 * 8. Garante que os chunks IDAT sejam contíguos e não intercalados por chunks não autorizados.
 * 9. Valida a presença obrigatória do chunk delimitador final IEND (sem lixo ou trailing bytes após o término).
 * 10. Valida dimensões requeridas (ex.: 192x192 para icon_192, 512x512 para icon_512).
 * 11. Descomprime o fluxo IDAT via zlib.inflateSync e valida a quantidade exata de scanlines e bytes de pixel.
 */
export function validateAndDecodePng(
  dataUrl: string,
  expectedWidth?: number,
  expectedHeight?: number,
  maxSizeBytes: number = 2.5 * 1024 * 1024
): PngValidationResult {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { valid: false, error: 'Formato de payload inválido. Esperada Data URL de imagem.' };
  }

  // 1. Extrair e validar MIME type
  const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+_-]+);base64,/);
  if (!mimeMatch) {
    return { valid: false, error: 'Codificação de imagem inválida ou cabeçalho Base64 ausente.' };
  }

  const mimeType = mimeMatch[1].toLowerCase();
  if (mimeType !== 'image/png') {
    return { valid: false, error: `Tipo MIME incompatível (${mimeType}). Apenas imagens PNG são aceitas para ícones PWA.` };
  }

  // 2. Decodificar Base64
  const base64Data = dataUrl.slice(mimeMatch[0].length);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch {
    return { valid: false, error: 'Falha ao decodificar Base64 da imagem.' };
  }

  // 3. Validação de tamanho mínimo (Assinatura: 8B + IHDR: 25B + IEND: 12B = 45B) e máximo
  if (buffer.length < 45) {
    return { valid: false, error: 'Arquivo truncado ou menor que o tamanho mínimo de um PNG válido (45 bytes).' };
  }

  if (buffer.length > maxSizeBytes) {
    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    return { valid: false, error: `Arquivo excede o limite máximo permitido (${sizeMb}MB > 2.5MB).` };
  }

  // 4. Validação de Magic Bytes oficiais do padrão PNG (RFC 2083)
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buffer[i] !== PNG_MAGIC[i]) {
      return { valid: false, error: 'Assinatura binária inválida. O arquivo não é um PNG genuíno.' };
    }
  }

  // 5. Varredura estrutural estrita dos chunks
  let offset = 8;
  let chunkIndex = 0;
  let hasIhdr = false;
  let hasIend = false;
  let seenIdat = false;
  let idatEnded = false;
  const idatBuffers: Buffer[] = [];

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compressionMethod = 0;
  let filterMethod = 0;
  let interlaceMethod = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      return { valid: false, error: 'Estrutura de chunk PNG truncada antes do cabeçalho de comprimento/tipo.' };
    }

    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    offset += 8;

    if (offset + chunkLength + 4 > buffer.length) {
      return { valid: false, error: `Chunk ${chunkType} truncado: comprimento declarado (${chunkLength}B) excede dados disponíveis no arquivo.` };
    }

    const chunkData = buffer.slice(offset, offset + chunkLength);
    const expectedCrc = buffer.readUInt32BE(offset + chunkLength);
    offset += chunkLength + 4;

    // Verificar integridade CRC32 do chunk
    if (typeof (zlib as any).crc32 === 'function') {
      const typeAndData = Buffer.concat([Buffer.from(chunkType, 'ascii'), chunkData]);
      const computedCrc = ((zlib as any).crc32(typeAndData) >>> 0);
      if (computedCrc !== expectedCrc) {
        return { valid: false, error: `Falha de integridade: CRC32 inválido no chunk ${chunkType}.` };
      }
    }

    // Regra da W3C: O primeiro chunk deve ser obrigatoriamente IHDR
    if (chunkIndex === 0) {
      if (chunkType !== 'IHDR') {
        return { valid: false, error: `Estrutura PNG inválida: o primeiro chunk deve ser IHDR, mas foi encontrado ${chunkType}.` };
      }
    }

    if (chunkType === 'IHDR') {
      if (hasIhdr) return { valid: false, error: 'Múltiplos chunks IHDR detectados no arquivo.' };
      if (chunkLength !== 13) return { valid: false, error: `Tamanho de chunk IHDR inválido (${chunkLength} bytes, esperado 13).` };
      hasIhdr = true;

      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData.readUInt8(8);
      colorType = chunkData.readUInt8(9);
      compressionMethod = chunkData.readUInt8(10);
      filterMethod = chunkData.readUInt8(11);
      interlaceMethod = chunkData.readUInt8(12);

      // Validação dos parâmetros permitidos pelo padrão PNG
      const validBitDepths = [1, 2, 4, 8, 16];
      if (!validBitDepths.includes(bitDepth)) {
        return { valid: false, error: `Profundidade de bits PNG inválida (${bitDepth}).` };
      }

      const validColorTypes = [0, 2, 3, 4, 6];
      if (!validColorTypes.includes(colorType)) {
        return { valid: false, error: `Tipo de cor PNG inválido (${colorType}).` };
      }

      if (compressionMethod !== 0) {
        return { valid: false, error: `Método de compressão PNG desconhecido (${compressionMethod}, esperado 0/Deflate).` };
      }

      if (filterMethod !== 0) {
        return { valid: false, error: `Método de filtragem PNG desconhecido (${filterMethod}, esperado 0/Adaptativo).` };
      }

      if (interlaceMethod !== 0 && interlaceMethod !== 1) {
        return { valid: false, error: `Método de entrelaçamento PNG desconhecido (${interlaceMethod}).` };
      }
    } else if (chunkType === 'IDAT') {
      if (idatEnded) {
        return { valid: false, error: 'Chunks IDAT não contíguos detectados (dados de imagem fragmentados após outros chunks).' };
      }
      seenIdat = true;
      idatBuffers.push(chunkData);
    } else if (chunkType === 'IEND') {
      if (chunkLength !== 0) {
        return { valid: false, error: `Chunk final IEND deve conter 0 bytes de dados, mas contém ${chunkLength}.` };
      }
      hasIend = true;
      break;
    } else {
      // Qualquer outro chunk após já termos visto IDAT significa que o fluxo de IDAT terminou
      if (seenIdat) {
        idatEnded = true;
      }
    }

    chunkIndex++;
  }

  if (!hasIhdr) {
    return { valid: false, error: 'Estrutura PNG inválida: cabeçalho IHDR não encontrado.' };
  }

  if (!hasIend) {
    return { valid: false, error: 'Arquivo PNG truncado: chunk delimitador final IEND ausente.' };
  }

  if (offset !== buffer.length) {
    return { valid: false, error: 'Dados extras corrompidos ou payload anômalo detectado após o chunk IEND.' };
  }

  if (idatBuffers.length === 0) {
    return { valid: false, error: 'Nenhum bloco de dados de imagem comprimido (IDAT) presente no PNG.' };
  }

  // 6. Validação das dimensões exigidas
  if (width === 0 || height === 0 || width > 4096 || height > 4096) {
    return { valid: false, error: `Dimensões PNG anômalas ou fora dos limites seguros (${width}x${height}).` };
  }

  if (expectedWidth && width !== expectedWidth) {
    return { valid: false, error: `Largura incompatível: esperado ${expectedWidth}px, recebido ${width}px.` };
  }

  if (expectedHeight && height !== expectedHeight) {
    return { valid: false, error: `Altura incompatível: esperado ${expectedHeight}px, recebido ${height}px.` };
  }

  // 7. Decodificação e descompressão real do fluxo de scanlines via zlib
  let decompressed: Buffer;
  try {
    const concatenatedIdat = Buffer.concat(idatBuffers);
    decompressed = zlib.inflateSync(concatenatedIdat);
  } catch (inflateErr: any) {
    return {
      valid: false,
      error: `PNG corrompido ou malformado: falha na descompressão dos dados de pixel (zlib): ${inflateErr.message}`,
    };
  }

  // 8. Verificação matemática estrita da quantidade de scanlines descomprimidas
  // Para imagens não entrelaçadas (interlaceMethod === 0), cada linha tem exatamente 1 byte de filtro + bytesPerRow
  if (interlaceMethod === 0) {
    let bytesPerPixel = 1;
    if (colorType === 2) bytesPerPixel = 3 * (bitDepth / 8); // RGB
    else if (colorType === 4) bytesPerPixel = 2 * (bitDepth / 8); // Gray + Alpha
    else if (colorType === 6) bytesPerPixel = 4 * (bitDepth / 8); // RGBA
    else if (colorType === 0 || colorType === 3) bytesPerPixel = Math.ceil((width * bitDepth) / 8) / width;

    const bytesPerRow = Math.ceil(width * bytesPerPixel);
    const expectedUncompressedBytes = height * (1 + bytesPerRow);

    if (decompressed.length !== expectedUncompressedBytes) {
      return {
        valid: false,
        error: `Dados descomprimidos incompletos ou divergentes da matriz de pixels (${decompressed.length}B recebidos, ${expectedUncompressedBytes}B esperados para ${width}x${height}).`,
      };
    }
  }

  return {
    valid: true,
    buffer,
    width,
    height,
    bitDepth,
    colorType,
    uncompressedBytes: decompressed.length,
  };
}
