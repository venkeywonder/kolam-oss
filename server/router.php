<?php
// Router for PHP's built-in server (local testing only, not for production):
//   php -S localhost:8080 server/router.php      (run from the project folder)
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('~/api(/|$)~', $path)) {
    require dirname(__DIR__) . '/api/index.php';
    return true;
}
if (preg_match('~/(server|storage|data|deploy)(/|$)|/\.|/README\.md$~', $path)) { http_response_code(404); return true; }
if (preg_match('~/(signup|login)$~', $path)) { header('Content-Type: text/html; charset=utf-8'); readfile(dirname(__DIR__) . '/index.html'); return true; }
return false;   // let the built-in server send the static file
