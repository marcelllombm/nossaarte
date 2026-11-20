/* Progressive enhancement: navigation, projects and quotes also have useful HTML fallbacks. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const config = window.NOSSA_ARTE;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const whatsappURL = (text) => `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(text)}`;

  // A single source of truth for business information; unconfirmed details stay hidden.
  $$('[data-whatsapp]').forEach(link => { link.href = whatsappURL(config.greeting); });
  $$('[data-phone-link]').forEach(link => {
    link.textContent = config.phoneDisplay;
    link.href = `tel:+${config.whatsapp}`;
  });
  $$('[data-hours]').forEach(element => { element.textContent = config.hours; });
  if (config.address) $('[data-address]').textContent = config.address;
  if (config.instagram && /^https:\/\/(www\.)?instagram\.com\//.test(config.instagram)) {
    $('#instagram-link').href = config.instagram;
    $('#instagram-link').hidden = false;
  }
  $('#year').textContent = new Date().getFullYear();

  const header = $('#site-header');
  const menu = $('#main-nav');
  const menuToggle = $('.menu-toggle');
  const mobile = window.matchMedia('(max-width: 650px)');
  function setMenu(open, restoreFocus = false) {
    menu.classList.toggle('is-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
    menu.inert = mobile.matches && !open;
    if (restoreFocus) menuToggle.focus();
  }
  setMenu(false);
  menuToggle.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
  mobile.addEventListener('change', () => setMenu(false));
  $$('a', menu).forEach(link => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('click', event => { if (!header.contains(event.target)) setMenu(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.classList.contains('is-open')) setMenu(false, true);
    if (event.key === 'Tab' && mobile.matches && menu.classList.contains('is-open')) {
      const links = $$('a', menu);
      if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); menuToggle.focus(); }
      else if (!event.shiftKey && document.activeElement === menuToggle) { event.preventDefault(); links[0].focus(); }
      else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); menuToggle.focus(); }
    }
  });
  const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();

  if ('IntersectionObserver' in window) {
    const navObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        $$('a', menu).forEach(link => {
          if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-15% 0px -60% 0px' });
    ['inicio', 'servicos', 'diferenciais', 'portfolio', 'contato'].forEach(id => navObserver.observe(document.getElementById(id)));
  }

  function selectService(value) {
    $('#service').value = value;
    $('#service').dispatchEvent(new Event('change', { bubbles: true }));
  }
  $$('[data-service]').forEach(link => link.addEventListener('click', () => selectService(link.dataset.service)));

  // Accessible filter buttons retain keyboard focus; hidden projects leave the accessibility tree.
  const filters = $$('.filter-button');
  const cards = $$('.project-card');
  filters.forEach(button => button.addEventListener('click', () => {
    filters.forEach(filter => {
      const active = filter === button;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    const visible = [];
    cards.forEach(card => {
      card.hidden = button.dataset.filter !== 'todos' && card.dataset.category !== button.dataset.filter;
      if (!card.hidden) visible.push(card);
    });
    $('#filter-status').textContent = `${visible.length} ${visible.length === 1 ? 'estudo visual disponível' : 'estudos visuais disponíveis'}.`;
    if (window.gsap && !motionPreference.matches) {
      window.gsap.fromTo(visible, { autoAlpha: 0, y: 15 }, { autoAlpha: 1, y: 0, duration: .35, stagger: .06, overwrite: true, clearProps: 'all' });
    }
    window.ScrollTrigger?.refresh();
  }));

  const projects = {
    fachada: { title: 'Uma fachada que convida.', category: 'Fachadas & letreiros', service: 'Fachadas e letreiros', image: 'img/projeto-fachada.svg', alt: 'Conceito de fachada Raízes com revestimento verde, letras-caixa e vitrines.', description: 'Um estudo de identidade aplicada à arquitetura: painel em ACM, letras-caixa com volume e uma paleta natural que acolhe desde o primeiro olhar.' },
    impressao: { title: 'Ideias em grande formato.', category: 'Impressão digital', service: 'Impressão digital', image: 'img/projeto-impressao.svg', alt: 'Conceito de campanha gráfica em cartazes azuis, laranjas e lilases.', description: 'Tipografia expressiva e cores de alto contraste em uma campanha pensada para ocupar espaços. Uma possibilidade para banners, painéis e materiais promocionais.' },
    adesivacao: { title: 'Sua marca em movimento.', category: 'Adesivação & envelopamento', service: 'Adesivação e envelopamento', image: 'img/projeto-adesivacao.svg', alt: 'Conceito de van envelopada em azul e laranja para a marca fictícia Órbita.', description: 'Um conceito de envelopamento de frota que transforma o veículo em um ponto de contato com a marca. Formas contínuas e boa leitura para comunicar em movimento.' },
    sinalizacao: { title: 'Design que dá direção.', category: 'Sinalização', service: 'Sinalização', image: 'img/projeto-sinalizacao.svg', alt: 'Conceito de placas de sinalização verde-oliva para um ambiente corporativo.', description: 'Um sistema de orientação com placas em camadas, identificação de ambientes e hierarquia clara. Design integrado à arquitetura para tornar cada caminho mais simples.' }
  };
  const modal = $('#project-modal');
  let modalTrigger = null;
  let modalService = '';
  $$('.project-open').forEach(button => button.addEventListener('click', () => {
    const project = projects[button.dataset.project];
    modalTrigger = button;
    modalService = project.service;
    $('#modal-title').textContent = project.title;
    $('#modal-category').textContent = project.category;
    $('#modal-description').textContent = project.description;
    $('#modal-image').src = project.image;
    $('#modal-image').alt = project.alt;
    if (typeof modal.showModal === 'function') {
      modal.showModal();
      document.body.classList.add('modal-open');
      $('.modal-close', modal).focus();
    } else {
      window.open(project.image, '_blank', 'noopener,noreferrer');
    }
  }));
  $('.modal-close', modal).addEventListener('click', () => modal.close());
  modal.addEventListener('click', event => {
    const bounds = modal.getBoundingClientRect();
    if (event.target === modal && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) modal.close();
  });
  modal.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    modalTrigger?.focus({ preventScroll: true });
  });
  $('#modal-cta').addEventListener('click', () => { selectService(modalService); modal.close(); });

  // No simulated delivery and no storage: visitors explicitly send the prepared message in WhatsApp.
  const form = $('#quote-form');
  const feedback = $('#form-feedback');
  const requiredFields = ['name', 'phone', 'service'].map(id => document.getElementById(id));
  $('.form-submit', form).disabled = false;
  function phoneDigits(value) {
    const digits = value.replace(/\D/g, '');
    return digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  }
  function fieldError(field) {
    if (field.id === 'name' && field.value.trim().length < 2) return 'Informe seu nome (pelo menos 2 caracteres).';
    if (field.id === 'phone' && !/^[1-9]\d\d{8,9}$/.test(phoneDigits(field.value))) return 'Informe um telefone com DDD e 10 ou 11 dígitos.';
    if (field.id === 'service' && !field.value) return 'Selecione um serviço ou escolha “Preciso de orientação”.';
    return '';
  }
  function validateField(field) {
    const error = fieldError(field);
    field.setAttribute('aria-invalid', String(Boolean(error)));
    document.getElementById(`${field.id}-error`).textContent = error;
    return !error;
  }
  requiredFields.forEach(field => {
    field.addEventListener('blur', () => { if (field.value || field.hasAttribute('aria-invalid')) validateField(field); });
    field.addEventListener('input', () => { if (field.getAttribute('aria-invalid') === 'true') validateField(field); });
    field.addEventListener('change', () => { if (field.hasAttribute('aria-invalid')) validateField(field); });
  });
  $('#phone').addEventListener('blur', event => {
    const digits = phoneDigits(event.target.value);
    if (/^\d{10,11}$/.test(digits)) {
      const middle = digits.length === 11 ? 7 : 6;
      event.target.value = `(${digits.slice(0, 2)}) ${digits.slice(2, middle)}-${digits.slice(middle)}`;
    }
  });
  ['input', 'change'].forEach(event => form.addEventListener(event, () => { feedback.hidden = true; }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const invalid = requiredFields.filter(field => !validateField(field));
    if (invalid.length) { feedback.hidden = true; invalid[0].focus(); return; }
    const data = new FormData(form);
    const message = [
      'Olá, Nossa Arte! Gostaria de solicitar um orçamento.',
      '',
      `Nome: ${String(data.get('name')).trim()}`,
      data.get('company')?.trim() ? `Empresa: ${data.get('company').trim()}` : '',
      `WhatsApp: ${String(data.get('phone')).trim()}`,
      `Serviço: ${data.get('service')}`,
      data.get('message')?.trim() ? `\nMinha ideia: ${data.get('message').trim()}` : ''
    ].filter((line, index) => line || index === 1).join('\n');
    $('#quote-whatsapp').href = whatsappURL(message);
    feedback.hidden = false;
    $('#quote-whatsapp').focus({ preventScroll: true });
    feedback.scrollIntoView({ behavior: motionPreference.matches ? 'instant' : 'smooth', block: 'nearest' });
    window.ScrollTrigger?.refresh();
  });

  // Content is visible by default. CDN failure never blocks reading or conversion.
  if (window.gsap && window.ScrollTrigger) {
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const intro = gsap.timeline({ defaults: { ease: 'power3.out', duration: .85 } });
      intro.from('.hero-badge', { autoAlpha: 0, y: 12 })
        .from('.hero h1 > span', { autoAlpha: 0, y: 28, stagger: .09 }, .12)
        .from('.hero-description, .hero-actions, .hero-proof', { autoAlpha: 0, y: 16, stagger: .1 }, .4)
        .from('.hero-visual', { autoAlpha: 0, y: 20, duration: 1.1 }, .2);
      $$('.reveal').forEach(element => {
        gsap.from(element, { autoAlpha: 0, y: 22, duration: .7, ease: 'power2.out', scrollTrigger: { trigger: element, start: 'top 93%', once: true } });
      });
    });
    document.fonts?.ready.then(() => ScrollTrigger.refresh());
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }
})();
