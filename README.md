# Nossa Arte

Landing page responsiva em **HTML5, CSS3 e JavaScript puro**, sem instalação de dependências ou etapa de build.

## Abrir

Abra `index.html` no navegador. Para visualizar por HTTP:

```sh
python3 -m http.server 8080
```

Acesse `http://localhost:8080`. Internet é necessária para as fontes, Three.js e GSAP via CDN. Sem essas bibliotecas, a página mantém o conteúdo, as interações locais e o logo estático.

## Arquivos

- `index.html`: conteúdo semântico, navegação, portfólio, formulário e modal.
- `css/styles.css`: identidade visual, componentes, responsividade e movimento reduzido.
- `js/config.js`: WhatsApp, telefone, horário e campos opcionais de endereço e Instagram.
- `js/main.js`: filtros, modal, formulário, menu e animações GSAP/ScrollTrigger.
- `js/logo-model.js`: geometria procedural do logo, monograma em curvas extrudadas, materiais e iluminação; quatro peças com pivôs independentes.
- `js/scene.js`: canvas da hero, timeline GSAP reversível de 550 ms, paralaxe, teclado/toque, movimento reduzido, descarte de recursos e fallback.
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
- `prefers-reduced-motion` respeitado em CSS, GSAP e Three.js.
- Renderização interrompida fora da tela e com a aba oculta; pixel ratio limitado.
- Logo original quando WebGL ou a biblioteca 3D não estiverem disponíveis; emblema CSS enquanto o PNG carrega. O modelo 3D não depende do carregamento da imagem.
- Imagens locais, dimensões reservadas e carregamento tardio do portfólio.
- Dependências com versões fixas: GSAP/ScrollTrigger 3.12.5 e Three.js 0.169.0.

Referências técnicas: [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer), [GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia/) e [ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/).

## Logo interativo

O logo inicia com as camadas separadas e **Remontar logo** ativo. Passe o cursor sobre a hero para explorar os anéis, o núcleo dourado e o monograma; retire-o para remontar. O botão alterna entre **Explorar camadas** e **Remontar logo** e funciona por toque e teclado; **Escape** remonta. Com movimento reduzido, a troca entre montado/desmontado é imediata e não há rotação automática.

A animação usa uma timeline GSAP com `power2.inOut` e 30 ms de defasagem entre camadas, totalizando 550 ms. A remontagem percorre a mesma timeline ao contrário. O canvas acompanha o ticker do GSAP e suspende a animação fora da tela; `gsap.matchMedia()` acompanha a preferência de movimento reduzido. Se o GSAP não carregar, a interpolação nativa mantém os controles funcionais.

O contorno foi reconstruído a partir de `img/logo.png` com a skill `img2threejs`. A profundidade e o verso são interpretações do desenho frontal. A especificação e as capturas de revisão ficam em `.img2threejs/`; esses arquivos não são necessários na hospedagem. Para alterar formas e materiais, edite `js/logo-model.js`; duração e enquadramento ficam em `js/scene.js`.

Para hospedar, envie `index.html` e as pastas `css`, `js` e `img` a qualquer hospedagem estática. Não há processo de build.
