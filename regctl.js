/*
 * regctl — éditeur de registre Windows à distance via MeshCentral.
 *
 * Flux : UI -> action HTTP -> dispatch canal plugin -> agent meshcore
 *        -> PowerShell -> retour 'pluginaction:result' -> serveur stocke
 *        -> UI polle l'action 'pollResult' pour récupérer.
 *
 * Aligné sur les patterns softctl : modules_meshcore/regctl.js,
 * consoleaction côté agent, plugin channel pour dispatch + retour.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

module.exports.regctl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.VIEWS = __dirname + '/views/';

    // Résultats en attente : dispatchId -> { resolve(result), reject(error), timer }.
    // Au lieu de Promesses on stocke les résultats dans une map ; l'UI polle.
    const pending = {};        // dispatchId -> true (en cours)
    const results = {};        // dispatchId -> { ok, data, error, time }
    const RESULT_TTL_MS = 5 * 60 * 1000;

    function newDispatchId() { return crypto.randomBytes(12).toString('hex'); }
    function gcResults() {
        const now = Date.now();
        Object.keys(results).forEach((k) => {
            if (now - results[k].time > RESULT_TTL_MS) delete results[k];
        });
    }
    setInterval(gcResults, 60 * 1000);

    function sendJson(res, status, body) {
        try {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
        } catch (e) {}
    }

    function readJsonParam(req) {
        try { return JSON.parse(req.query.payload || '{}'); } catch (e) { return {}; }
    }

    obj.handleAdminReq = function (req, res, user) {
        const action = String((req.query && req.query.action) || '');

        if (!action) {
            // Pas d'action : on rend la vue handlebars du plugin (panneau admin).
            return res.render(path.join(__dirname, 'views/regctl'), { user: user });
        }

        if (action === 'ping') return sendJson(res, 200, { ok: true, plugin: 'regctl' });

        if (action === 'agents') {
            // Liste des agents Windows connectés (registre = Windows uniquement).
            const db = obj.meshServer.db;
            const wsagents = obj.meshServer.webserver.wsagents || {};
            db.GetAllType('node', (err, nodes) => {
                if (err) return sendJson(res, 500, { error: err.message });
                db.GetAllType('mesh', (err2, meshes) => {
                    if (err2) return sendJson(res, 500, { error: err2.message });
                    const meshById = {};
                    (meshes || []).forEach((m) => { meshById[m._id] = m.name; });
                    const list = (nodes || [])
                        .filter((n) => {
                            // agent.id : voir AGENT_TYPE map MC. Windows = 1, 2 (legacy), 3, 4, etc.
                            // Plutôt que filtrer trop strict, on garde tout et on note l'OS.
                            return !!wsagents[n._id];
                        })
                        .map((n) => ({
                            id: n._id,
                            name: n.name || '?',
                            mesh: meshById[n.meshid] || '?',
                            meshid: n.meshid,
                            online: !!wsagents[n._id],
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                    sendJson(res, 200, { agents: list });
                });
            });
            return;
        }

        // --- Opérations registre. Toutes envoient un message plugin à l'agent
        //     et retournent un dispatchId. L'UI polle ensuite via 'pollResult'.

        const opMap = {
            enumKeys:    { needs: ['nodeId', 'path'] },
            enumValues:  { needs: ['nodeId', 'path'] },
            readValue:   { needs: ['nodeId', 'path', 'name'] },
            writeValue:  { needs: ['nodeId', 'path', 'name', 'type', 'data'] },
            deleteValue: { needs: ['nodeId', 'path', 'name'] },
            deleteKey:   { needs: ['nodeId', 'path'] },
            createKey:   { needs: ['nodeId', 'path'] },
        };

        if (opMap[action]) {
            const payload = readJsonParam(req);
            const op = opMap[action];
            for (let i = 0; i < op.needs.length; i++) {
                const k = op.needs[i];
                if (payload[k] === undefined || payload[k] === null || payload[k] === '') {
                    return sendJson(res, 400, { error: 'paramètre manquant: ' + k });
                }
            }
            const ws = obj.meshServer.webserver.wsagents[payload.nodeId];
            if (!ws || typeof ws.send !== 'function') {
                return sendJson(res, 200, { ok: false, error: 'agent déconnecté' });
            }
            const dispatchId = newDispatchId();
            pending[dispatchId] = true;
            const message = Object.assign({
                action: 'plugin',
                plugin: 'regctl',
                pluginaction: action,
                dispatchId: dispatchId,
            }, payload);
            try {
                ws.send(JSON.stringify(message));
                return sendJson(res, 200, { ok: true, dispatchId: dispatchId });
            } catch (e) {
                delete pending[dispatchId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
        }

        if (action === 'pollResult') {
            // L'UI appelle ça en boucle après dispatch pour récupérer le résultat.
            const id = String(req.query.dispatchId || '');
            if (!id) return sendJson(res, 400, { error: 'dispatchId requis' });
            if (results[id]) {
                const r = results[id];
                delete results[id];
                return sendJson(res, 200, { ready: true, result: r });
            }
            if (pending[id]) return sendJson(res, 200, { ready: false });
            return sendJson(res, 200, { ready: false, unknown: true });
        }

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    };

    // Reçoit les messages remontés par les agents (canal plugin).
    obj.serveraction = function (command, myparent) {
        try {
            if (!command || command.plugin !== 'regctl') return;
            if (command.pluginaction !== 'result') return;
            const id = command.dispatchId;
            if (!id) return;
            results[id] = {
                ok: !!command.ok,
                data: command.data,
                error: command.error,
                time: Date.now(),
            };
            delete pending[id];
        } catch (e) {
            console.log('regctl: serveraction error: ' + e.message);
        }
    };

    obj.exports = [];
    return obj;
};
