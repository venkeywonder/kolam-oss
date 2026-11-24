#!/usr/bin/env node
/*
 * Builds the logo packs for the Icon element (src/cards/icon.js) into src/vendor/logos/:
 *   index.json            what the picker lists: packs > groups > [ref, title, search words, dark]
 *   brand/<slug>.svg      Simple Icons (CC0), filled with the brand's colour
 *   dev/<name>.svg        Devicon (MIT), in colour
 *   aws/<slug>.svg        AWS Architecture Icons (service, resource and group icons), unchanged artwork;
 *                         <slug>.dark.svg is AWS's own version for dark backgrounds where there is one
 * dark: 1 = a black logo (shown inverted on a dark board), 2 = has a .dark.svg.
 *
 * Usage: node scripts/build-logos.mjs <simple-icons package dir> <devicon package dir> <AWS Asset-Package dir>
 * (npm pack simple-icons devicon, and the Asset Package zip from https://aws.amazon.com/architecture/icons/)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [siDir, devDir, awsDir] = process.argv.slice(2);
if (!awsDir) { console.error('Usage: node scripts/build-logos.mjs <simple-icons dir> <devicon dir> <AWS Asset-Package dir>'); process.exit(1); }
const OUT = new URL('../src/vendor/logos/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
for (const d of ['brand', 'dev', 'aws']) mkdirSync(join(OUT, d), { recursive: true });

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = s => s.toLowerCase().replace(/&/g, 'and').replace(/\.net/g, 'dotnet').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__MACOSX' ? [] : walk(p)) : [p]; });
// lighter files: no XML prologue, comments, titles or editor metadata; ids only when nothing points at them
function tidy(svg) {
  svg = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<(sodipodi|inkscape|metadata)[\s\S]*?(\/>|<\/\1[^>]*>)/g, '').replace(/>\s+</g, '><').trim();
  if (!/url\(#|href="#/.test(svg)) svg = svg.replace(/\s(id|data-name)="[^"]*"/g, '');
  return svg;
}
const lum = hex => { const n = parseInt(hex, 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
// a logo drawn only in near-black (or with no fill at all, which is black) disappears on a dark board
function blackOnly(svg) {
  const cols = [...svg.matchAll(/(?:fill|stop-color)(?:="|:\s*)(#[0-9a-f]{3,6}|black|none|currentColor)/gi)].map(m => m[1].toLowerCase()).filter(c => c !== 'none');
  if (!cols.length) return !/fill=/.test(svg) || /fill="(#000|#000000|black)"/i.test(svg);
  return cols.every(c => c === 'black' || c === 'currentcolor' || (c.startsWith('#') && lum(c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1)) < .02));
}

/* ---------- Logos: Devicon + Simple Icons, grouped by what they're for ---------- */
const CATS = {
  'Cloud & hosting': 'amazonwebservices googlecloud google azure microsoftazure digitalocean heroku vercel netlify cloudflare cloudflarepages cloudflareworkers firebase supabase linode akamai fastly oracle oraclecloud ibmcloud alibabacloud hetzner ovh vultr render railway flydotio flyio openstack rackspace scaleway backblaze bunnynet hostinger godaddy namecheap appwrite pocketbase upstash neon planetscale deno denodeploy githubpages gitlabpages surge koyeb fly',
  'Databases & storage': 'postgresql mysql mariadb sqlite mongodb redis cassandra apachecassandra couchdb couchbase neo4j dynamodb amazondynamodb cockroachdb cockroachlabs elasticsearch opensearch influxdb timescale clickhouse snowflake bigquery googlebigquery oracle microsoftsqlserver sqlserver sqldeveloper firebird realm arangodb rethinkdb memcached minio ceph scylladb surrealdb fauna faunadb prisma sequelize typeorm drizzle duckdb questdb singlestore tidb vitess yugabytedb apachehbase hbase apachehive trino presto databricks dbeaver pgadmin redisinsight azuresqldatabase dgraph meilisearch typesense algolia solr apachesolr qdrant pinecone weaviate milvus chroma',
  'Messaging & streaming': 'apachekafka kafka rabbitmq nats natsio apachepulsar pulsar zeromq mqtt eclipsemosquitto activemq apacheactivemq amazonsqs googlepubsub celery sidekiq bullmq temporal inngest twilio sendgrid mailgun mailchimp resend postmark socketdotio socketio pusher ably webrtc grpc graphql apollographql trpc kong traefikproxy traefik envoyproxy nginx apache apachehttpserver haproxy caddy',
  'DevOps & infrastructure': 'docker kubernetes helm podman containerd terraform pulumi ansible chef puppet vagrant packer consul vault nomad hashicorp jenkins githubactions gitlab circleci travisci travis teamcity bamboo argo argocd fluxcd tekton spinnaker drone bitbucket github git azuredevops azurepipelines bitrise fastlane codemagic sonarqube sonarcloud snyk dependabot renovatebot renovate nexus jfrog artifactory harbor rancher openshift redhatopenshift k3s minikube istio linkerd cilium portainer nixos nix gradle maven apachemaven bazel cmake make npm yarn pnpm bun webpack vite rollup esbuild babel turborepo nx lerna',
  'Monitoring & logging': 'prometheus grafana datadog newrelic sentry elastic elasticstack kibana logstash splunk dynatrace honeycomb opentelemetry jaeger zipkin pagerduty opsgenie statuspage uptimekuma betterstack loki fluentd fluentbit appdynamics instana nagios zabbix checkmk icinga posthog mixpanel amplitude googleanalytics hotjar segment',
  'Languages': 'javascript typescript python java kotlin swift go golang rust c cplusplus csharp dotnet dotnetcore php ruby scala elixir erlang haskell clojure fsharp dart lua perl r julia matlab fortran cobol zig nim crystal groovy objectivec ocaml solidity webassembly bash powershell html5 html css3 css sass less markdown json yaml toml xml',
  'Frameworks & libraries': 'react reactjs nextjs nextdotjs vuejs vuedotjs nuxt nuxtjs angular angularjs svelte sveltekit solidjs solid preact astro remix gatsby qwik emberjs ember backbonejs jquery alpinejs htmx lit tailwindcss tailwind bootstrap materialui mui chakraui antdesign shadcnui radixui storybook redux mobx zustand rxjs threejs d3js d3 nodejs nodedotjs express expressjs fastify nestjs koa hono django flask fastapi rubyonrails rails laravel symfony codeigniter spring springboot quarkus micronaut dotnet aspnet blazor phoenixframework gin fiber echo actix rocket flutter reactnative ionic capacitor electron tauri expo xamarin unity unrealengine godot godotengine jest vitest mocha jasmine cypress playwright puppeteer selenium junit pytest testinglibrary wordpress drupal strapi contentful sanity ghost shopify',
  'AI & data': 'openai chatgpt anthropic claude googlegemini gemini huggingface langchain llamaindex ollama mistralai perplexity replicate tensorflow pytorch keras scikitlearn numpy pandas jupyter anaconda kaggle opencv mlflow kubeflow apachespark spark apacheairflow airflow dbt apacheflink flink hadoop apachehadoop tableau powerbi looker metabase streamlit gradio weightsandbiases nvidia cuda deepmind midjourney stabilityai elevenlabs cohere groq',
  'Auth & security': 'auth0 okta keycloak clerk supertokens firebaseauth onelogin jsonwebtokens jwt letsencrypt cloudflare 1password bitwarden lastpass hashicorpvault vault snyk crowdstrike cisco fortinet paloaltonetworks wireguard openvpn tailscale zerotier openid oauth passport passportjs',
  'Payments & commerce': 'stripe paypal square braintree adyen razorpay mollie klarna afterpay wise revolut visa mastercard americanexpress applepay googlepay alipay wechat paddle lemonsqueezy gumroad chargebee recurly shopify woocommerce magento bigcommerce ebay etsy coinbase bitcoin ethereum binance plaid quickbooks xero',
  'Communication & social': 'slack discord microsoftteams zoom googlemeet whatsapp telegram signal messenger facebook instagram x twitter linkedin youtube tiktok reddit pinterest snapchat threads mastodon bluesky twitch spotify gmail microsoftoutlook intercom zendesk freshdesk crisp hubspot salesforce mailchimp',
  'Productivity & design': 'notion confluence jira trello asana linear clickup monday basecamp airtable googledrive dropbox box onedrive googledocs googlesheets microsoftexcel microsoftword microsoftpowerpoint figma sketch adobe adobexd adobephotoshop photoshop adobeillustrator illustrator canva framer miro whimsical excalidraw obsidian evernote todoist calendly zapier make n8n ifttt postman insomnia swagger openapiinitiative vscode visualstudiocode visualstudio intellijidea webstorm pycharm xcode androidstudio vim neovim emacs sublimetext cursor',
  'Systems & devices': 'linux ubuntu debian fedora centos redhat archlinux alpinelinux almalinux rockylinux opensuse windows windows11 microsoftwindows apple macos ios android raspberrypi arduino chrome googlechrome firefox safari microsoftedge opera brave',
};
const CAT_OF = new Map();
for (const [cat, words] of Object.entries(CATS)) for (const w of words.split(/\s+/)) if (!CAT_OF.has(w)) CAT_OF.set(w, cat);
// Devicon's tags place what the list above doesn't
const TAG_CATS = [['database', 'Databases & storage'], ['nosql', 'Databases & storage'], ['cloud', 'Cloud & hosting'], ['hosting', 'Cloud & hosting'],
  ['monitoring', 'Monitoring & logging'], ['deployment', 'DevOps & infrastructure'], ['automation', 'DevOps & infrastructure'], ['kubernetes', 'DevOps & infrastructure'],
  ['version-control', 'DevOps & infrastructure'], ['build', 'DevOps & infrastructure'], ['package', 'DevOps & infrastructure'], ['security', 'Auth & security'], ['auth', 'Auth & security'],
  ['machine-learning', 'AI & data'], ['ai', 'AI & data'], ['data-science', 'AI & data'], ['data', 'AI & data'], ['language', 'Languages'],
  ['framework', 'Frameworks & libraries'], ['library', 'Frameworks & libraries'], ['testing', 'Frameworks & libraries'], ['cms', 'Frameworks & libraries'],
  ['editor', 'Productivity & design'], ['ide', 'Productivity & design'], ['IDE', 'Productivity & design'], ['design', 'Productivity & design'], ['os', 'Systems & devices'], ['linux', 'Systems & devices']];
const MORE = 'More brands';
const logoGroups = new Map([...Object.keys(CATS), MORE].map(c => [c, []]));
const seen = new Set();

const devicon = JSON.parse(readFileSync(join(devDir, 'devicon.json'), 'utf8'));
for (const d of devicon) {
  const v = ['original', 'plain', 'original-wordmark', 'plain-wordmark'].find(x => d.versions.svg.includes(x)); if (!v) continue;
  let svg; try { svg = readFileSync(join(devDir, 'icons', d.name, `${d.name}-${v}.svg`), 'utf8'); } catch { continue; }
  svg = tidy(svg);
  writeFileSync(join(OUT, 'dev', d.name + '.svg'), svg);
  const n = norm(d.name), cat = CAT_OF.get(n) || (d.altnames || []).map(a => CAT_OF.get(norm(a))).find(Boolean) || TAG_CATS.find(([t]) => d.tags.includes(t))?.[1] || MORE;
  const title = d.altnames?.find(a => /[A-Z]/.test(a)) || d.name;
  logoGroups.get(cat).push(['dev/' + d.name, title === d.name ? d.name : title, [d.name, ...(d.altnames || []), ...d.tags].join(' ').toLowerCase(), blackOnly(svg) ? 1 : 0]);
  seen.add(n); for (const a of d.altnames || []) seen.add(norm(a));
}
const si = JSON.parse(readFileSync(join(siDir, 'data', 'simple-icons.json'), 'utf8'));
for (const s of si) {
  const n = norm(s.slug); if (seen.has(n) || seen.has(norm(s.title))) continue;
  let svg; try { svg = readFileSync(join(siDir, 'icons', s.slug + '.svg'), 'utf8'); } catch { continue; }
  svg = tidy(svg).replace('<svg ', `<svg fill="#${s.hex}" `).replace(/\srole="img"/, '');
  writeFileSync(join(OUT, 'brand', s.slug + '.svg'), svg);
  const aka = [...(s.aliases?.aka || []), ...(s.aliases?.dup || []).map(x => x.title)];
  const cat = CAT_OF.get(n) || CAT_OF.get(norm(s.title)) || MORE;
  logoGroups.get(cat).push(['brand/' + s.slug, s.title, [s.slug, ...aka].join(' ').toLowerCase(), lum(s.hex) < .02 ? 1 : 0]);
}
// devicon names are lowercase ("postgresql"): show them the way the brand writes them where Simple Icons knows it
const SI_TITLE = new Map(si.flatMap(s => [[norm(s.slug), s.title], [norm(s.title), s.title]]));
const TITLES = { amazonwebservices: 'AWS', azuresqldatabase: 'Azure SQL Database', azuredevops: 'Azure DevOps', azuredatafactory: 'Azure Data Factory', argocd: 'Argo CD',
  angularjs: 'AngularJS', googlecloud: 'Google Cloud', microsoftsqlserver: 'Microsoft SQL Server', nodejs: 'Node.js', vuejs: 'Vue.js', nuxtjs: 'Nuxt', threejs: 'Three.js', d3js: 'D3.js' };
for (const g of logoGroups.values()) for (const e of g) if (e[0].startsWith('dev/') && e[1] === e[0].slice(4)) e[1] = TITLES[e[1]] || SI_TITLE.get(norm(e[1])) || e[1][0].toUpperCase() + e[1].slice(1);
for (const g of logoGroups.values()) g.sort((a, b) => a[1].localeCompare(b[1], 'en', { sensitivity: 'base' }));

/* ---------- AWS ---------- */
const AWS_CATS = { 'App-Integration': 'Application Integration', 'Application-Integration': 'Application Integration', IoT: 'Internet of Things', 'Internet-of-Things': 'Internet of Things',
  'General-Icons': 'General', 'Management-Governance': 'Management & Governance', 'Networking-Content-Delivery': 'Networking & Content Delivery',
  'Security-Identity-Compliance': 'Security, Identity & Compliance', 'Migration-Modernization': 'Migration & Modernization', 'Front-End-Web-Mobile': 'Front-End Web & Mobile' };
const awsCat = d => AWS_CATS[d] || d.replace(/-/g, ' ');
const awsGroups = new Map([['Groups (VPC, region, subnet…)', []]]);
const awsIds = new Set();
const title = s => s.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').replace(/ \./g, ' .').trim();
function addAws(cat, name, light, dark, extra = '') {
  let id = slug(name); while (awsIds.has(id)) id += '-2';
  awsIds.add(id);
  writeFileSync(join(OUT, 'aws', id + '.svg'), tidy(readFileSync(light, 'utf8')));
  if (dark) writeFileSync(join(OUT, 'aws', id + '.dark.svg'), tidy(readFileSync(dark, 'utf8')));
  if (!awsGroups.has(cat)) awsGroups.set(cat, []);
  awsGroups.get(cat).push(['aws/' + id, name, (name + ' ' + extra).toLowerCase(), dark ? 2 : 0]);
}
const files = walk(awsDir).filter(f => f.endsWith('.svg'));
// service icons (64 px), resource icons (48 px), then group icons (32 px)
for (const f of files.filter(f => /\/Arch_[^/]+\/64\/Arch_.*_64\.svg$/.test(f) && !/_Dark_64/.test(f))) {
  const cat = awsCat(f.match(/\/Arch_([^/]+)\/64\//)[1]);
  const name = title(basename(f).replace(/^Arch_/, '').replace(/(_Light)?_64\.svg$/, ''));
  const dark = /_Light_64\.svg$/.test(f) ? f.replace('_Light_64', '_Dark_64') : null;
  addAws(cat, name, f, dark, 'service ' + cat);
}
for (const f of files.filter(f => /\/Res_[^/]+\/(Res_48_Light\/)?Res_.*_48(_Light)?\.svg$/.test(f))) {
  const cat = awsCat(f.match(/Resource-Icons[^/]*\/Res_([^/]+)\//)[1]);
  const name = title(basename(f).replace(/^Res_/, '').replace(/_48(_Light)?\.svg$/, ''));
  const dark = /_Light\.svg$/.test(f) ? f.replace('Res_48_Light', 'Res_48_Dark').replace('_48_Light.svg', '_48_Dark.svg') : null;
  addAws(cat, name, f, dark, 'resource ' + cat);
}
for (const f of files.filter(f => /Architecture-Group-Icons[^/]*\/[^/]+_32\.svg$/.test(f) && !/_Dark\.svg$/.test(f))) {
  const name = title(basename(f).replace(/_32\.svg$/, '')).replace(/^AWS Cloud logo$/, 'AWS Cloud (logo)');
  const dark = files.includes(f.replace('_32.svg', '_32_Dark.svg')) ? f.replace('_32.svg', '_32_Dark.svg') : null;
  addAws('Groups (VPC, region, subnet…)', name, f, dark, 'group');
}
const awsOrder = [...awsGroups.keys()].filter(k => !/^Groups|^General$/.test(k)).sort();
const awsList = ['General', ...awsOrder, 'Groups (VPC, region, subnet…)'].filter(k => awsGroups.get(k)?.length).map(k => ({ name: k, icons: awsGroups.get(k) }));

const index = {
  packs: [
    { id: 'logos', name: 'Logos', note: 'Devicon (MIT) and Simple Icons (CC0). Logos are trademarks of their owners.', groups: [...logoGroups].filter(([, v]) => v.length).map(([name, icons]) => ({ name, icons })) },
    { id: 'aws', name: 'AWS', note: 'AWS Architecture Icons, for diagrams. AWS and its icons are trademarks of Amazon.com, Inc. or its affiliates.', groups: awsList },
  ],
};
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
for (const p of index.packs) console.log(p.name, p.groups.map(g => `${g.name}: ${g.icons.length}`).join(', '));
copyFileSync(join(siDir, 'LICENSE.md'), join(OUT, 'brand', 'LICENSE.md'));
copyFileSync(join(devDir, 'LICENSE'), join(OUT, 'dev', 'LICENSE'));
