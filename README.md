# Otimizador de Assets Adaptativo

Implementação de carregamento dinâmico de imagens utilizando a `Network Information API` (`navigator.connection`).

## Funcionamento

O sistema verifica a qualidade da conexão (`effectiveType`, `downlink` e `saveData`) e seleciona a resolução adequada antes de buscar as imagens:

- **4G:** 1200×800 (qualidade 85%)
- **3G:** 600×400 (qualidade 60%)
- **2G / Slow-2G / Save-Data:** 240×160 (qualidade 30%)

## Arquivos

- `index.html`: Estrutura da página, barra de métricas e configuração PWA.
- `style.css`: Layout minimalista responsivo com barra de navegação mobile estilo app.
- `script.js`: Leitura de `navigator.connection`, Speed Test real, registro do Service Worker e cálculo de consumo em KB.
- `manifest.json` e `sw.js`: Configuração de Progressive Web App (instalável no celular e desktop via GitHub Pages).
