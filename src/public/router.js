import { routeHref, stripRoutePrefix } from './api.js';

let routeMap = new Map();
let lastPath = null;

function navigate(path) {
  history.pushState(null, '', routeHref(path));
  handleRoute();
}

function render(html) {
  document.getElementById('app').innerHTML = html;
}

function registerRoute(pattern, handler) {
  routeMap.set(pattern, handler);
}

function handleRoute() {
  const path = stripRoutePrefix(window.location.pathname);

  document.querySelectorAll('nav a').forEach(a => {
    const nav = a.dataset.nav;
    a.classList.toggle('active',
      (nav === 'marketplace' && path === '/') ||
      (nav === 'marketplace' && path === '/marketplace') ||
      (nav === 'agents' && path === '/agents') ||
      (nav === 'admin' && path === '/admin')
    );
  });

  document.querySelector('nav a[data-nav="home"]')?.setAttribute('href', routeHref('/'));
  document.querySelector('nav a[data-nav="marketplace"]')?.setAttribute('href', routeHref('/marketplace'));
  document.querySelector('nav a[data-nav="agents"]')?.setAttribute('href', routeHref('/agents'));
  document.querySelector('nav a[data-nav="admin"]')?.setAttribute('href', routeHref('/admin'));

  const appEl = document.getElementById('app');
  const mainEl = document.querySelector('main');
  appEl.classList.remove('admin-main');
  mainEl?.classList.remove('mp-wide');

  // Route matching
  if (path === '/' || path === '/marketplace') {
    mainEl?.classList.add('mp-wide');
    routeMap.get('/')?.();
  }
  else if (path === '/agents') routeMap.get('/agents')?.();
  else if (path.startsWith('/agents/')) {
    const agentId = path.slice(8);
    routeMap.get('/agents/:id')?.(agentId);
  }
  else if (path === '/admin') routeMap.get('/admin')?.();
  else if (routeMap.has('/')) routeMap.get('/')?.();

  lastPath = path;
}

document.addEventListener('click', e => {
  const target = e.target.closest('[data-nav]');
  if (target && target.tagName === 'A') {
    e.preventDefault();
    navigate(stripRoutePrefix(target.getAttribute('href')));
  }
});

window.addEventListener('popstate', handleRoute);

export { navigate, render, registerRoute, handleRoute };