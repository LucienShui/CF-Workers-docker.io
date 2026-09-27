// Cloudflare Worker Docker registry proxy.

const DEFAULT_UPSTREAM = 'registry-1.docker.io';
const AUTH_SERVER = 'https://auth.docker.io';
const DEFAULT_BLOCKED_USER_AGENTS = ['netcraft'];

const PREFLIGHT_INIT = {
	status: 204,
	headers: {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
		'access-control-max-age': '1728000',
	},
};

function upstreamForHost(host) {
	const routes = {
		quay: 'quay.io',
		gcr: 'gcr.io',
		'k8s-gcr': 'k8s.gcr.io',
		k8s: 'registry.k8s.io',
		ghcr: 'ghcr.io',
		cloudsmith: 'docker.cloudsmith.io',
		nvcr: 'nvcr.io',
		test: DEFAULT_UPSTREAM,
	};
	return Object.hasOwn(routes, host) ? [routes[host], false] : [DEFAULT_UPSTREAM, true];
}

function parseUserAgents(value) {
	return String(value)
		.replace(/[\t |"'\r\n]+/g, ',')
		.replace(/,+/g, ',')
		.replace(/^,|,$/g, '')
		.split(',')
		.filter(Boolean)
		.map(item => item.toLowerCase());
}

function nginxPage() {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Welcome to nginx!</title>
<style>body{width:35em;margin:0 auto;font-family:Tahoma,Verdana,Arial,sans-serif}</style></head>
<body><h1>Welcome to nginx!</h1><p>The nginx web server is successfully installed and
working. Further configuration is required.</p><p>Thank you for using nginx.</p></body></html>`;
}

function searchPage() {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Docker Hub 镜像搜索</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
font-family:system-ui,sans-serif;background:linear-gradient(120deg,#1a90ff,#003eb3);padding:20px}
.container{text-align:center;width:min(800px,100%);color:#fff}.logo{font-size:64px}.title{font-size:2em;margin:0 0 10px}
.subtitle{opacity:.9;margin:0 0 30px}.search{display:flex;max-width:600px;height:50px;margin:auto}
#query{flex:1;border:0;border-radius:8px 0 0 8px;padding:0 20px;font-size:16px;outline:0}
button{border:0;border-radius:0 8px 8px 0;padding:0 25px;background:#06f;color:#fff;cursor:pointer;font-size:16px}</style></head>
<body><main class="container"><div class="logo">🐳</div><h1 class="title">Docker Hub 镜像搜索</h1>
<p class="subtitle">快速查找、下载和部署 Docker 容器镜像</p><form class="search" id="form">
<input id="query" placeholder="输入关键词搜索镜像，如：nginx、mysql、redis…"><button>搜索</button></form>
<p>提示：按回车键快速搜索</p></main><script>
document.getElementById('form').addEventListener('submit',event=>{event.preventDefault();const q=document.getElementById('query').value.trim();if(q)location.href='/search?q='+encodeURIComponent(q)});
</script></body></html>`;
}

function proxyRedirect(request, location, baseHost) {
	const target = new URL(location, `https://${baseHost}`);
	const headers = new Headers(request.headers);
	headers.delete('host');
	// Do not forward registry credentials to a different redirect origin.
	if (target.origin !== `https://${baseHost}`) {
		headers.delete('authorization');
		headers.delete('cookie');
	}
	return proxy(target, {
		method: request.method,
		headers,
		redirect: 'follow',
		body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
	});
}

async function proxy(url, init) {
	const upstreamResponse = await fetch(url, init);
	const headers = new Headers(upstreamResponse.headers);
	headers.set('access-control-expose-headers', '*');
	headers.set('access-control-allow-origin', '*');
	headers.delete('content-security-policy');
	headers.delete('content-security-policy-report-only');
	headers.delete('clear-site-data');
	return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

export default {
	async fetch(request, env = {}) {
		if (request.method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
			const headers = new Headers(PREFLIGHT_INIT.headers);
			headers.set('access-control-allow-headers', request.headers.get('access-control-request-headers'));
			return new Response(null, { ...PREFLIGHT_INIT, headers });
		}
		const requestUrl = new URL(request.url);
		const requestAgent = (request.headers.get('user-agent') || '').toLowerCase();
		const workerOrigin = `https://${requestUrl.hostname}`;
		const blockedAgents = DEFAULT_BLOCKED_USER_AGENTS.concat(env.UA ? parseUserAgents(env.UA) : []);

		let upstreamHost;
		let fakePage;
		const namespace = requestUrl.searchParams.get('ns');
		const selectedHost = requestUrl.searchParams.get('hubhost') || requestUrl.hostname;
		if (namespace) {
			upstreamHost = namespace === 'docker.io' ? DEFAULT_UPSTREAM : namespace;
			fakePage = false;
		} else {
			[upstreamHost, fakePage] = upstreamForHost(selectedHost.split('.')[0]);
		}

		if (blockedAgents.some(agent => requestAgent.includes(agent))) {
			return new Response(nginxPage(), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
		}

		const browserRequest = requestAgent.includes('mozilla');
		const searchRequest = ['/v1/search', '/v1/repositories'].some(path => requestUrl.pathname.includes(path));
		const registryRequest = /^\/v2(?:\/|$)/.test(requestUrl.pathname);
		const tokenRequest = requestUrl.pathname === '/token' || requestUrl.pathname.startsWith('/token/');
		if (!registryRequest && !tokenRequest && (browserRequest || searchRequest)) {
			if (requestUrl.pathname === '/') {
				if (env.URL302) return Response.redirect(env.URL302, 302);
				if (env.URL) {
					if (env.URL.toLowerCase() === 'nginx') return new Response(nginxPage(), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
					return fetch(new Request(env.URL, request));
				}
				if (fakePage) return new Response(searchPage(), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
			} else {
				requestUrl.hostname = fakePage ? 'registry.hub.docker.com' : upstreamHost;
				const query = requestUrl.searchParams.get('q');
				if (query && query.includes('library/') && query !== 'library/') requestUrl.searchParams.set('q', query.replace('library/', ''));
				return fetch(new Request(requestUrl, request));
			}
		}

		// Proxy Docker token requests while preserving Basic Authorization.
		if (tokenRequest) {
			const tokenUrl = new URL(requestUrl.pathname + requestUrl.search, AUTH_SERVER);
			const tokenHeaders = new Headers(request.headers);
			tokenHeaders.delete('host');
			return fetch(new Request(tokenUrl, {
				method: request.method,
				headers: tokenHeaders,
				body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
				redirect: 'follow',
			}));
		}

		if (upstreamHost === DEFAULT_UPSTREAM && /^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(requestUrl.pathname) && !/^\/v2\/library/.test(requestUrl.pathname)) {
			requestUrl.pathname = '/v2/library/' + requestUrl.pathname.split('/v2/')[1];
		}

		// Set the destination URL as well as the upstream request headers.
		requestUrl.hostname = upstreamHost;
		requestUrl.searchParams.delete('ns');
		requestUrl.searchParams.delete('hubhost');
		const headers = new Headers(request.headers);
		headers.delete('host');
		const upstreamRequest = new Request(requestUrl, {
			method: request.method,
			headers,
			body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
			redirect: 'manual',
		});
		const upstreamResponse = await fetch(upstreamRequest);
		const responseHeaders = new Headers(upstreamResponse.headers);
		const challenge = responseHeaders.get('www-authenticate');
		if (challenge) responseHeaders.set('www-authenticate', challenge.replaceAll(AUTH_SERVER, workerOrigin));
		const location = responseHeaders.get('location');
		if (location) return proxyRedirect(request, location, upstreamHost);
		return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders });
	},
};
