# Nossa Arte

Landing page responsiva em **HTML5, CSS3 e JavaScript puro**, sem instalação de dependências ou etapa de build.

## Abrir

Abra `index.html` no navegador. Para visualizar por HTTP:

```sh
python3 -m http.server 8080
```

Acesse `http://localhost:8080`. Internet é necessária para as fontes, Three.js e GSAP via CDN. Sem essas bibliotecas, a página mantém o conteúdo, as interações locais e a composição visual em CSS.

## Arquivos

- `index.html`: conteúdo semântico, navegação, portfólio, formulário e modal.
- `css/styles.css`: identidade visual, componentes, responsividade e movimento reduzido.
- `js/config.js`: WhatsApp, telefone, horário e campos opcionais de endereço e Instagram.
- `js/main.js`: filtros, modal, formulário, menu e animações GSAP/ScrollTrigger.
- `js/scene.js`: escultura procedural Three.js, resposta ao cursor, pausa, descarte de recursos e fallback.
- `img/`: logo original, favicon e quatro estudos visuais SVG originais.
- `docs/design.md`: decisões de design e limites editoriais.

## Contato e orçamento

Telefone confirmado: **(82) 99965-5907**. Atendimento: **segunda a sexta, das 9h às 18h**.

O formulário valida os campos obrigatórios e prepara uma mensagem codificada. O visitante clica em **Continuar no WhatsApp**, revisa e envia a mensagem. O site não informa envio concluído, não utiliza backend, não guarda dados no navegador e não envia formulários por e-mail.

Endereço e Instagram não foram informados. Configure as informações reais em `js/config.js`; o link do Instagram aparece automaticamente quando preenchido. A seção de localização orienta o visitante a consultar a região de atendimento.

## Portfólio

Os quatro projetos são **conceitos ilustrativos**, identificados na página e no modal. Não representam clientes ou trabalhos executados. Para adicionar projetos reais, atualize as imagens e os cards em `index.html` e os detalhes no objeto `projects` em `js/main.js`.

## Acessibilidade e desempenho

- Navegação por teclado, link para pular conteúdo, foco visível e labels permanentes.
- Modal nativo com Escape, foco contido e retorno ao botão que o abriu.
- Formulário com erros associados aos campos e feedback acessível.
- `prefers-reduced-motion` respeitado em CSS, GSAP e Three.js; pausa manual na cena.
- Renderização interrompida fora da tela e com a aba oculta; pixel ratio limitado.
- Composição CSS quando WebGL ou a biblioteca 3D não estiverem disponíveis.
- Imagens locais, dimensões reservadas e carregamento tardio do portfólio.
- Dependências com versões fixas: GSAP/ScrollTrigger 3.12.5 e Three.js 0.169.0.

Referências técnicas: [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer), [GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia/) e [ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/).

Para hospedar, envie `index.html` e as pastas `css`, `js` e `img` a qualquer hospedagem estática. Não há processo de build.
