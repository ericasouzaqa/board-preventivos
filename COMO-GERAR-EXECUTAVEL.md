# Como gerar o executável

## Pré-requisito

Instale o [Node.js](https://nodejs.org) (versão 18 ou superior).

## Passos

### 1. Instalar as dependências

Na pasta do projeto, abra o terminal e execute:

```bash
npm install
```

### 2. Testar antes de gerar

Para rodar o app antes de empacotar:

```bash
npm start
```

### 3. Gerar o executável

**Windows (.exe):**
```bash
npm run build
```

O instalador será gerado na pasta `dist/`.

## Resultado

- **Windows:** `dist/Painel de Qualidade Preventiva Setup 1.0.0.exe`
- **Mac:** `dist/Painel de Qualidade Preventiva-1.0.0.dmg`
- **Linux:** `dist/Painel de Qualidade Preventiva-1.0.0.AppImage`

## Observações

- Os dados ficam salvos no localStorage do Electron (persiste entre sessões).
- O app funciona 100% offline após instalado.
- Não é necessário instalar nada além do próprio executável gerado.
