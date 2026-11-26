# Otimizador de Assets Adaptativo

Implementação de carregamento dinâmico de imagens utilizando a `Network Information API` (`navigator.connection`).

## Funcionamento

O sistema verifica a qualidade da conexão (`effectiveType`, `downlink` e `saveData`) e seleciona a resolução adequada antes de buscar as imagens:

- **4G:** 1920×1200 (alta resolução)
- **3G:** 640×400 (resolução média)
- **2G / Slow-2G / Save-Data:** 160×100 (baixa resolução)

## Arquivos

- `index.html`: Estrutura da página, barra de métricas e configuração PWA.
- `style.css`: Layout minimalista responsivo com barra de navegação mobile estilo app.
- `script.js`: Leitura de `navigator.connection`, Speed Test real, registro do Service Worker e cálculo de consumo em KB.
- `manifest.json` e `sw.js`: Configuração de Progressive Web App (instalável no celular e desktop via GitHub Pages).
