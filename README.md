# RythmPhone 🎵

Usa o celular como caixa de som do PC pelo cabo USB.

## Como usar
1. Dê dois cliques em `iniciar.bat` (ou rode `npm install` e depois `npm start`).
2. No PC, a página `http://localhost:3000` abre no Chrome/Edge → clique em **Começar a transmitir** → escolha **Tela inteira** e marque **Compartilhar áudio do sistema**.
3. Conecte o celular pelo USB usando um destes jeitos:
   - **Tethering USB** (Android: Ponto de acesso e tethering → Tethering USB; iPhone: Acesso Pessoal). Depois abra no celular o endereço `http://<IP>:3000/phone` que aparece na página do PC.
   - **ADB** (Depuração USB ativa + `platform-tools` nesta pasta ou no PATH). Depois abra no celular `http://localhost:3000/phone`.
4. No celular, toque em **Tocar**.

## Como funciona
PC (Chrome) captura o áudio do sistema → PCM 16-bit 48 kHz estéreo via WebSocket → servidor Node → celular toca com Web Audio, com buffer ajustável (atraso padrão de ~80 ms).
