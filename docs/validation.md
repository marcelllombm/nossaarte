# Verificação da implementação

Atualização da hero em 20/11/2026, com Chrome headless. Resultados e capturas da versão com GSAP em `.img2threejs/evidence/integration-gsap/`:

- Logo inicia em quatro camadas separadas, com **Remontar logo** ativo.
- Timeline GSAP de 550 ms, com defasagem de 30 ms entre camadas; saída e interrupções rápidas revertem sem deslocamento acumulado.
- Enter, Escape, toque, pausa manual e movimento reduzido funcionam.
- Canvas transparente, responsivo a mudanças do container, DPR limitado a 2.
- Timeline e renderização param fora da tela e retornam quando visíveis; o ticker também retoma ao desativar movimento reduzido.
- Falta de WebGL, falha do CDN e perda de contexto restauram o logo estático; PNG atrasado não bloqueia a geometria.
- Falha apenas do GSAP preserva o canvas e os controles com interpolação nativa; perda de contexto descarta a timeline e remove o renderizador do ticker.
- Desktop em 1440 px e celular em 390 px revisados visualmente, sem recorte do objeto ou rolagem horizontal.
- 10.952 triângulos e quatro chamadas de desenho; nenhum erro de JavaScript nos testes normais.

O histórico abaixo registra a validação da página anterior à substituição da escultura da hero:

Verificado em 19/11/2026, usando Google Chrome headless e o protocolo DevTools.

- HTML servido por HTTP local; GSAP, ScrollTrigger e Three.js carregados pelos CDNs configurados.
- Cena 3D renderizada; composição e página completa revisadas por captura de tela.
- Layout sem rolagem horizontal em 320, 375, 390, 768, 1024 e 1440 px.
- Todas as categorias de portfólio retornam os cards correspondentes.
- Modal abre com foco no fechamento; Escape fecha e retorna o foco ao projeto.
- CTA do modal seleciona o serviço no formulário.
- Todos os links dos seis serviços e a opção de orientação correspondem a opções válidas do formulário.
- Formulário vazio marca os três campos obrigatórios e foca o primeiro erro.
- Mensagem válida usa o número confirmado 5582999655907 e preserva caracteres especiais e quebras de linha.
- Alterações nos campos invalidam a mensagem preparada anteriormente.
- Não há persistência de dados do formulário em localStorage.
- Menu mobile abre, fecha após navegação e remove links ocultos da ordem de foco.
- Preferência de movimento reduzido pausa a cena e desativa rolagem animada.
- Perda forçada de contexto WebGL ativa a composição CSS.
- Nenhum erro de JavaScript ou falha de rede observado no carregamento normal.
- Sintaxe JavaScript e estrutura XML dos SVGs verificadas.
- HTML com tags balanceadas e IDs únicos; CSS formatado para manutenção.
- Com CDNs bloqueados, o conteúdo, o formulário, os filtros e a composição CSS permanecem disponíveis.
- Abertura direta de `index.html` pelo protocolo `file://` carrega a cena 3D e as interações.

O envio real de uma mensagem não foi executado: a ação final é realizada pelo visitante no WhatsApp. Endereço, Instagram e fotos de projetos reais ainda precisam ser fornecidos pelo responsável pela empresa.
