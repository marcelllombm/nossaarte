# Verificação da implementação

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
