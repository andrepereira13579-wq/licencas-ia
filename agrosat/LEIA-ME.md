# AgroSat — versão 5

Web app de monitoramento de fazendas: satélite + situação ambiental e fundiária.

## Funções
**Cadastro da fazenda**: pelo código do CAR, tocando no mapa sobre a fazenda, ou por arquivo (KML, KMZ, GeoJSON, Shapefile .zip).

**Imagens**: Sentinel-2 (10 m, a cada ~5 dias), com mapas em cor real, NDVI, NDRE e zonas de atenção, recortados no perímetro. Nuvem e sombra ficam mascaradas.
**Histórico**: gráfico de NDVI e NDRE de 6 a 36 meses.
**Comparar**: mostra onde o NDVI subiu ou caiu entre duas datas.
**Situação** (área + 5 km ao redor):
- CAR: situação (ativo, pendente, suspenso, cancelado) e CARs de outros imóveis sobrepostos
- SIGEF/INCRA: parcelas certificadas e quanto da área cobrem
- Embargos IBAMA: dentro da área e no entorno
- Desmatamento PRODES (INPE): área por ano, com destaque para o que é posterior a 2008
- Focos de queimada INPE dos últimos 10 dias
- Clima: resumo (detalhes na aba Clima)

**Clima**: chuva diária e acumulada em 7, 15, 30, 60 ou 90 dias, 12 meses ou período personalizado; dias com chuva; dias seguidos sem chuva; soma térmica (base 10 ou 15 °C); temperatura máxima e mínima; previsão de 7 dias.
**Subdivisões**: se o KML tiver piquetes, glebas ou talhões dentro do contorno, o app mostra o NDVI de cada um, do pior para o melhor.
**⬇ KML**: baixa o perímetro e as divisões para abrir no Google Earth.
**📐 Memorial**: memorial descritivo com vértices (lat/long e UTM SIRGAS 2000), azimutes, distâncias, perímetro e área. Dá para imprimir ou salvar em PDF e baixar a planilha CSV. Não substitui o memorial certificado do SIGEF.
**Relatório**: botão 📄, depois "Imprimir / salvar PDF", com seu nome e empresa no cabeçalho.
**Camadas no mapa** (ícone de camadas, canto superior direito): CAR, SIGEF, embargos e PRODES de toda a região.

---

## Como colocar no ar: 2 partes, ambas grátis

### Parte 1: servidor-ponte (Cloudflare), uns 5 minutos
Os sites do governo (CAR, INCRA, IBAMA, INPE) não aceitam consulta direta do navegador. A ponte faz essa consulta no lugar dele.
1. Crie uma conta grátis em **dash.cloudflare.com**.
2. No menu, abra **Workers e Pages**, clique em **Criar**, depois em **Criar Worker**. Dê o nome `agrosat-ponte` e clique em **Implantar**.
3. Clique em **Editar código**, apague tudo, cole o conteúdo do arquivo `ponte/worker.js` e clique em **Implantar**.
4. Copie o endereço que aparece (algo como `https://agrosat-ponte.SEUNOME.workers.dev`).
5. Para testar, abra esse endereço com `/saude` no final. Deve aparecer `{"ok":true}`.

### Parte 2: o site (Netlify)
1. Abra o arquivo `config.js` num editor de texto (Bloco de Notas serve) e cole o endereço da ponte:
   `window.AGROSAT_PROXY = 'https://agrosat-ponte.SEUNOME.workers.dev';`
   Preencha também seu nome, empresa e contato para o relatório.
2. Entre em **app.netlify.com/drop** e arraste a pasta `AgroSat` (a pasta do site, sem a pasta `ponte`).
3. Pronto: sai o link do site para abrir no celular e no notebook.

Se não quiser editar o config.js, dá para colar o endereço da ponte em ⚙ Configurações dentro do app. Nesse caso, a configuração vale só naquele aparelho.

## Limitações desta versão
- As fazendas ficam salvas no aparelho onde foram cadastradas. O login de clientes é a próxima etapa.
- As bases do governo saem do ar com frequência. Quando uma falha, o cartão dela fica cinza e as outras continuam funcionando.
- Os dados são públicos e consultados na hora. Não substituem certidões oficiais.

- Clima vem do Open-Meteo, que é gratuito para uso não comercial. Se o app for vendido como assinatura, o Open-Meteo pede o plano comercial deles.
