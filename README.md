# Antares

Navegador para Windows baseado no Chromium (Electron), com visual orbital: Spaces, Split View,
Orbits, Missions, Mapa Estelar e central de comandos.

## Baixar

Instalador e versão portátil: [última versão](https://github.com/Tenebre60/antares/releases/latest).
A versão instalada se atualiza sozinha.

## Como as atualizações funcionam

- **Robô de atualização** (`.github/workflows/auto-update.yml`): todo dia procura uma correção de
  segurança do Electron/Chromium da mesma linha. Se houver, atualiza, roda todos os testes e, só se
  passarem, publica uma versão nova. Linhas novas do Electron abrem um aviso (issue) para revisão.
- **Publicar versão** (`release.yml`): quando a versão do `package.json` muda, testa, monta o
  instalador no Windows e publica no GitHub Releases.
- **No navegador**: a versão instalada procura atualizações algumas vezes por dia, baixa em segundo
  plano, confere o SHA-512 publicado com a versão e instala ao fechar o navegador.

## Desenvolvimento

```
npm ci
npm start              # rodar
npm run build:linux    # montar para testes
npm test               # testes (precisa de tela :99 com Xvfb e openbox)
npm run dist           # instalador do Windows
```
