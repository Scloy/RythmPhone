# RythmPhone 🎵

Use o celular como caixa de som do PC — direto do navegador, sem instalar nada.

O áudio vai **direto do PC para o celular** via WebRTC (Opus estéreo, 256 kbps). O site só serve para os dois se encontrarem (sinalização pelo servidor público do PeerJS), então ele pode ser hospedado como site estático na Vercel.

## Hospedar na Vercel
1. Em [vercel.com/new](https://vercel.com/new), importe este repositório.
2. Não precisa configurar nada (o `vercel.json` já aponta para a pasta `public`). Clique em **Deploy**.

## Como usar
1. **No PC (Chrome ou Edge):** abra o site e clique em **Transmitir**.
   - Som do PC todo: escolha **Tela inteira** e ative **Compartilhar áudio do sistema**.
   - Só uma guia: escolha **Guia do Chrome** e ative **Compartilhar áudio da guia**.
   - ⚠️ **Janela** não funciona: o Chrome/Edge não capturam áudio de janelas no Windows.
   - Só um programa: use o [VB-CABLE](https://vb-audio.com/Cable/) e escolha **Dispositivo de áudio → CABLE Output**.
2. **No celular:** escaneie o QR code (ou abra `/phone` e digite o código) e toque em **Conectar e tocar**.

### Pelo cabo USB
Ligue o cabo e ative o **Tethering USB** no celular (iPhone: **Acesso Pessoal**). O WebRTC vai preferir a rede local, ou seja, o cabo. O celular mostra **Conexão: Local** quando está indo direto pelo cabo/Wi-Fi.

## Estrutura
- `public/index.html` + `pc.js`: transmissor (PC)
- `public/phone.html` + `phone.js`: receptor (celular)
- `public/common.js`: códigos de sala e ajuste do Opus para alta qualidade
