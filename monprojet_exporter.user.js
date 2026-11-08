// ==UserScript==
// @name         SGDF - Export Participants monprojet
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Exporte la liste des participants et du staff d'un camp (et de ses sous-camps) en CSV
// @author       Clément Truillet
// @match        https://monprojet.sgdf.fr/*
// @updateURL    https://raw.githubusercontent.com/ctruillet/sgdf/main/monprojet_exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/ctruillet/sgdf/main/monprojet_exporter.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------
    const API_URL_TEMPLATE = "/api/camps/{id}?module=ENTETE";
    const DELAI_ENTRE_REQUETES_MS = 300;
    const MAX_TENTATIVES = 3;
    const SEPARATEUR = ";";

    const COLONNES = [
        { titre: "N° adhérent",       cle: "numero" },
        { titre: "Civilité",          cle: "civilite" },
        { titre: "Prénom",            cle: "prenom" },
        { titre: "Nom",               cle: "nom" },
        { titre: "Date de naissance", cle: "dateNaissance" },
        { titre: "Rôle",              cle: "roles" },
        { titre: "Arrivée",           cle: "arrivee" },
        { titre: "Départ",            cle: "depart" },
        { titre: "Email",             cle: "email" },
        { titre: "Tél. portable",     cle: "telephone" },
        { titre: "Tél. père",         cle: "telephonePere" },
        { titre: "Tél. mère",         cle: "telephoneMere" },
        { titre: "Camp(s)",           cle: "camps" },
        { titre: "ID camp(s)",        cle: "idsCamps" },
    ];

    // Codes "roleStaff" de monprojet -> libellés (repris de l'interface du site)
    const ROLES_STAFF = {
        D:  "Directeur",
        DA: "Directeur adjoint",
        RU: "Responsable d'unité",
        RF: "Responsable farfadet",
        C:  "Animateur",
        A:  "Autre",
    };
    const ROLE_JEUNE = "Jeune";
    const ROLE_INVITE = "Invité";

    // Ordre d'affichage dans le CSV : staff (par hiérarchie), puis invités, puis jeunes
    const ORDRE_ROLES = ["Directeur", "Directeur adjoint", "Responsable d'unité",
                         "Responsable farfadet", "Animateur", "Autre"];
    function rangRole(role) {
        if (role === ROLE_JEUNE) return 100;
        if (role === ROLE_INVITE) return 50;
        const i = ORDRE_ROLES.indexOf(role);
        return i >= 0 ? i : ORDRE_ROLES.length; // staff au code inconnu : après "Autre"
    }

    function libelleRoleStaff(item) {
        if (item.compositionType === "VISITEUR") return ROLE_INVITE;
        const code = nettoyer(item.roleStaff).toUpperCase();
        return ROLES_STAFF[code] || (code ? `Staff (${code})` : "Staff");
    }

    let capturedAuthToken = null;
    let preparedCsvBlob = null;
    let preparedFilename = "";
    let annulationDemandee = false;

    // ------------------------------------------------------------------
    // Interception du token Bearer (fetch + XHR)
    // ------------------------------------------------------------------
    function memoriserToken(valeur) {
        if (typeof valeur === 'string' && valeur.toLowerCase().startsWith('bearer ')) {
            capturedAuthToken = valeur;
        }
    }

    function lireAuthorization(headers) {
        if (!headers) return null;
        if (headers instanceof Headers) return headers.get('Authorization');
        if (Array.isArray(headers)) {
            const h = headers.find(([k]) => String(k).toLowerCase() === 'authorization');
            return h ? h[1] : null;
        }
        if (typeof headers === 'object') {
            const k = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
            return k ? headers[k] : null;
        }
        return null;
    }

    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            memoriserToken(lireAuthorization(init?.headers));
            if (input instanceof Request) memoriserToken(input.headers.get('Authorization'));
        } catch (e) { /* ne jamais casser l'appli */ }
        return originalFetch.apply(this, arguments);
    };

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
        try {
            if (header && header.toLowerCase() === 'authorization') memoriserToken(value);
        } catch (e) { /* idem */ }
        return originalSetRequestHeader.apply(this, arguments);
    };

    function rechercherToken() {
        if (capturedAuthToken) return capturedAuthToken;
        const regex = /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/;
        for (const store of [localStorage, sessionStorage]) {
            // On privilégie la clé utilisée par monprojet, puis on balaie le reste
            const cles = ['ddc-currentUser', ...Object.keys(store)];
            for (const cle of cles) {
                const val = store.getItem(cle);
                const match = val && val.match(regex);
                if (match) return `Bearer ${match[0]}`;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Utilitaires de formatage
    // ------------------------------------------------------------------
    const nettoyer = (v) => String(v ?? "").trim();

    function formaterDate(brute) {
        const m = nettoyer(brute).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
    }

    // "0612345678" -> "06 12 34 56 78" : lisible et Excel conserve le 0 initial
    function formaterTelephone(brut) {
        let t = nettoyer(brut).replace(/[\s.\-]/g, "");
        if (/^\+33\d{9}$/.test(t)) t = "0" + t.slice(3);
        if (/^0\d{9}$/.test(t)) return t.replace(/(\d{2})(?=\d)/g, "$1 ");
        return nettoyer(brut);
    }

    // Échappement CSV + protection contre l'injection de formules (=, +, -, @)
    function celluleCSV(valeur) {
        let v = nettoyer(valeur);
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
        return `"${v.replace(/"/g, '""')}"`;
    }

    function nomFichierSur(texte) {
        return nettoyer(texte)
            .normalize("NFD").replace(/[̀-ͯ]/g, "")
            .replace(/[^A-Za-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 60);
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function getCampIdFromUrl() {
        const match = window.location.pathname.match(/\/camp\/(\d+)/);
        return match ? match[1] : null;
    }

    // ------------------------------------------------------------------
    // Interface
    // ------------------------------------------------------------------
    window.addEventListener('DOMContentLoaded', initUI);

    function initUI() {
        const style = document.createElement('style');
        style.textContent = `
            #sgdf-exporter-btn {
                position: fixed; bottom: 20px; left: 20px; z-index: 99999;
                background-color: #003366; color: #fff; border: none;
                padding: 12px 18px; border-radius: 25px;
                font: bold 14px Arial, sans-serif; cursor: pointer;
                box-shadow: 0 4px 10px rgba(0,0,0,0.3); transition: all 0.2s ease;
            }
            #sgdf-exporter-btn:hover { background-color: #002244; transform: translateY(-2px); }
            #sgdf-exporter-overlay {
                display: none; position: fixed; inset: 0;
                background: rgba(0,0,0,0.5); z-index: 99999;
            }
            #sgdf-exporter-modal {
                display: none; position: fixed; top: 50%; left: 50%;
                transform: translate(-50%, -50%); z-index: 100000;
                width: 520px; max-width: 90%; background: #fff; border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.4); padding: 20px;
                font-family: Arial, sans-serif; color: #333;
            }
            #sgdf-exporter-modal h3 {
                margin-top: 0; color: #003366;
                border-bottom: 2px solid #eee; padding-bottom: 10px;
            }
            #sgdf-progress-wrapper { margin: 15px 0 10px; display: none; }
            #sgdf-progress-info {
                display: flex; justify-content: space-between; gap: 10px;
                font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #003366;
            }
            #sgdf-progress-container {
                width: 100%; background: #e0e0e0; border-radius: 10px; overflow: hidden;
                height: 16px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
            }
            #sgdf-progress-bar {
                width: 0%; height: 100%;
                background: linear-gradient(90deg, #003366, #0066cc); transition: width 0.3s ease;
            }
            #sgdf-logs {
                background: #f4f6f8; border: 1px solid #ddd; border-radius: 6px;
                height: 180px; overflow-y: auto; padding: 10px;
                font: 12px monospace; margin: 10px 0 15px; white-space: pre-wrap;
            }
            .sgdf-btn {
                background: #003366; color: #fff; border: none; padding: 8px 15px;
                border-radius: 5px; cursor: pointer; font-weight: bold;
                transition: background-color 0.2s ease; margin-left: 8px;
            }
            .sgdf-btn:disabled { background: #ccc !important; cursor: not-allowed; }
            .sgdf-btn-success { background-color: #28a745 !important; }
            .sgdf-btn-success:hover { background-color: #218838 !important; }
            .sgdf-btn-danger { background-color: #c0392b !important; }
            .sgdf-btn-secondary { background: #888; }
        `;
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'sgdf-exporter-btn';
        btn.textContent = '📊 Exporter les participants';
        document.body.appendChild(btn);

        const overlay = document.createElement('div');
        overlay.id = 'sgdf-exporter-overlay';
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'sgdf-exporter-modal';
        modal.innerHTML = `
            <h3>Exportation des participants</h3>
            <p style="font-size:13px;color:#555;margin-bottom:5px;">Camp cible : <strong id="sgdf-target-id">-</strong></p>
            <label style="font-size:13px;color:#555;display:block;margin:6px 0;">
                <input type="checkbox" id="sgdf-opt-staff" checked> Inclure le staff
            </label>
            <label style="font-size:13px;color:#555;display:block;margin:6px 0;">
                <input type="checkbox" id="sgdf-opt-enfants" checked> Inclure les sous-camps
            </label>
            <div id="sgdf-progress-wrapper">
                <div id="sgdf-progress-info">
                    <span id="sgdf-progress-status">Traitement en cours...</span>
                    <span id="sgdf-progress-percent">0%</span>
                </div>
                <div id="sgdf-progress-container"><div id="sgdf-progress-bar"></div></div>
            </div>
            <div id="sgdf-logs">Cliquez sur "Démarrer l'export" pour lancer le traitement.</div>
            <div style="text-align:right;">
                <button id="sgdf-action-btn" class="sgdf-btn" data-state="start">Démarrer l'export</button>
                <button id="sgdf-close-btn" class="sgdf-btn sgdf-btn-secondary">Fermer</button>
            </div>
        `;
        document.body.appendChild(modal);

        const $ = (id) => document.getElementById(id);
        const actionBtn = $('sgdf-action-btn');

        // Le bouton flottant n'apparaît que sur une page de camp (navigation SPA comprise)
        let derniereUrl = null;
        setInterval(() => {
            if (location.href === derniereUrl) return;
            derniereUrl = location.href;
            btn.style.display = getCampIdFromUrl() ? 'block' : 'none';
        }, 500);

        // --- Logs & progression ---
        function log(message) {
            const box = $('sgdf-logs');
            box.textContent += "\n" + message;
            box.scrollTop = box.scrollHeight;
        }

        function updateProgress(percent, statusText) {
            $('sgdf-progress-wrapper').style.display = 'block';
            const p = Math.min(100, Math.max(0, Math.round(percent)));
            $('sgdf-progress-bar').style.width = p + '%';
            $('sgdf-progress-percent').textContent = p + '%';
            if (statusText) $('sgdf-progress-status').textContent = statusText;
        }

        function setActionButtonState(state) {
            actionBtn.dataset.state = state;
            actionBtn.disabled = false;
            actionBtn.classList.remove('sgdf-btn-success', 'sgdf-btn-danger');
            if (state === 'download') {
                actionBtn.textContent = "📥 Télécharger le CSV";
                actionBtn.classList.add('sgdf-btn-success');
            } else if (state === 'running') {
                actionBtn.textContent = "⏹ Annuler";
                actionBtn.classList.add('sgdf-btn-danger');
            } else {
                actionBtn.textContent = "Démarrer l'export";
            }
            $('sgdf-opt-staff').disabled = state === 'running';
            $('sgdf-opt-enfants').disabled = state === 'running';
        }

        // --- Accès API avec nouvelles tentatives ---
        async function recupererCamp(idCamp, ctx) {
            const url = API_URL_TEMPLATE.replace("{id}", encodeURIComponent(idCamp));
            for (let tentative = 1; tentative <= MAX_TENTATIVES; tentative++) {
                const headers = { "Accept": "application/json, text/plain, */*" };
                if (ctx.token) headers["Authorization"] = ctx.token;

                let response;
                try {
                    response = await originalFetch.call(window, url, { headers, credentials: "include" });
                } catch (e) {
                    log(`🌐 Erreur réseau sur le camp ${idCamp} (essai ${tentative}/${MAX_TENTATIVES}) : ${e.message}`);
                    await sleep(1000 * tentative);
                    continue;
                }

                if (response.ok) return response.json();

                if (response.status === 401 || response.status === 403) {
                    // Le token a peut-être été rafraîchi par l'appli entre-temps
                    const nouveau = rechercherToken();
                    if (nouveau && nouveau !== ctx.token && tentative < MAX_TENTATIVES) {
                        log(`🔄 Token rafraîchi, nouvel essai pour le camp ${idCamp}...`);
                        ctx.token = nouveau;
                        continue;
                    }
                    log(`⛔ Accès refusé (${response.status}) au camp ${idCamp}. Session expirée ? Rechargez la page.`);
                    return null;
                }

                if (response.status === 429 || response.status >= 500) {
                    log(`⏳ Erreur ${response.status} sur le camp ${idCamp}, nouvel essai...`);
                    await sleep(1500 * tentative);
                    continue;
                }

                log(`⚠️ Erreur ${response.status} sur le camp ${idCamp}`);
                return null;
            }
            log(`❌ Abandon du camp ${idCamp} après ${MAX_TENTATIVES} essais.`);
            return null;
        }

        // --- Ajout / fusion d'un adhérent ---
        function ajouterAdherent(adh, role, camp, ctx, debutPresence, finPresence) {
            if (!adh) return;
            const prenom = nettoyer(adh.prenom).toUpperCase();
            const nom = nettoyer(adh.nom).toUpperCase();
            if (!prenom || !nom) return;

            const dateNaissance = formaterDate(adh.dateNaissance);
            // Clé fiable : le numéro d'adhérent ; à défaut prénom + nom + date (évite de fusionner les homonymes)
            const cle = nettoyer(adh.numero) || `${prenom}_${nom}_${dateNaissance}`;

            let personne = ctx.personnes.get(cle);
            if (!personne) {
                personne = {
                    numero: nettoyer(adh.numero),
                    civilite: nettoyer(typeof adh.civilite === 'object' ? adh.civilite?.libelle : adh.civilite),
                    prenom, nom, dateNaissance,
                    email: nettoyer(adh.email),
                    telephone: formaterTelephone(adh.telephonePortable),
                    telephonePere: formaterTelephone(adh.telephonePere),
                    telephoneMere: formaterTelephone(adh.telephoneMere),
                    _roles: new Set(), _camps: new Map(),
                };
                ctx.personnes.set(cle, personne);
            } else {
                ctx.doublons++;
            }
            personne._roles.add(role);
            personne._camps.set(String(camp.id), camp.libelle);

            // Dates de présence (ISO "AAAA-MM-JJ", comparables comme du texte).
            // Staff : ses propres dates ; jeunes : dates du camp. Plusieurs camps : plus tôt / plus tard.
            const debut = nettoyer(debutPresence || camp.dateDebut).slice(0, 10);
            const fin = nettoyer(finPresence || camp.dateFin).slice(0, 10);
            if (debut && (!personne._debut || debut < personne._debut)) personne._debut = debut;
            if (fin && (!personne._fin || fin > personne._fin)) personne._fin = fin;
        }

        // --- Parcours (itératif, protégé contre les cycles) ---
        async function parcourirCamps(idRacine, ctx) {
            const file = [idRacine];
            const vus = new Set();
            let estimes = 1;

            while (file.length) {
                if (annulationDemandee) { log("🛑 Export annulé."); return false; }

                const idCamp = String(file.shift());
                if (vus.has(idCamp)) continue;
                vus.add(idCamp);

                if (vus.size > 1) await sleep(DELAI_ENTRE_REQUETES_MS);
                log(`📡 Extraction du camp ${idCamp}...`);
                const data = await recupererCamp(idCamp, ctx);

                if (data) {
                    const camp = {
                        id: idCamp,
                        libelle: nettoyer(data.libelle),
                        dateDebut: data.dateDebut,
                        dateFin: data.dateFin,
                    };
                    ctx.ordreCamps.set(idCamp, ctx.ordreCamps.size); // camp principal = 0, puis sous-camps
                    if (ctx.idRacine === idCamp) ctx.libelleRacine = camp.libelle;

                    const participants = data.campAdherentParticipants || [];
                    participants.forEach(it => ajouterAdherent(it.adherent || it, ROLE_JEUNE, camp, ctx));

                    let nbStaff = 0;
                    if (ctx.inclureStaff) {
                        const staffs = data.campAdherentStaffs || [];
                        nbStaff = staffs.length;
                        staffs.forEach(it => ajouterAdherent(it.adherent || it, libelleRoleStaff(it), camp, ctx,
                                                             it.dateDebutPresence, it.dateFinPresence));
                    }
                    log(`   ↳ ${camp.libelle || "(sans nom)"} : ${participants.length} participant(s)` +
                        (ctx.inclureStaff ? `, ${nbStaff} staff` : ""));

                    if (ctx.inclureEnfants) {
                        for (const enfant of data.campEnfants || []) {
                            if (enfant?.id && !vus.has(String(enfant.id))) {
                                file.push(enfant.id);
                                estimes++;
                            }
                        }
                    }
                } else {
                    ctx.erreurs++;
                }

                ctx.campsTraites = vus.size;
                updateProgress((vus.size / estimes) * 100,
                    `Camp ${idCamp} traité (${vus.size}/${estimes})`);
            }
            return true;
        }

        // --- Génération du CSV ---
        function preparerCSV(ctx) {
            const lignes = [...ctx.personnes.values()].map(p => {
                const roles = [...p._roles].sort((a, b) => rangRole(a) - rangRole(b));
                // Une personne présente dans plusieurs camps est rangée dans le premier rencontré
                const premierCamp = [...p._camps.keys()][0];
                return {
                    ...p,
                    _rangCamp: ctx.ordreCamps.get(premierCamp) ?? Infinity,
                    _rangRole: rangRole(roles[0]),
                    roles: roles.join(" | "),
                    arrivee: formaterDate(p._debut),
                    depart: formaterDate(p._fin),
                camps: [...p._camps.values()].filter(Boolean).join(" | "),
                    idsCamps: [...p._camps.keys()].join(" | "),
                };
            });

            if (lignes.length === 0) {
                log("⚠️ Aucun participant à exporter.");
                setActionButtonState('start');
                return;
            }

            // Tri : camp (principal puis sous-camps) > rôle (staff, invités, jeunes) > nom > prénom
            lignes.sort((a, b) =>
                a._rangCamp - b._rangCamp ||
                a._rangRole - b._rangRole ||
                a.nom.localeCompare(b.nom, 'fr') ||
                a.prenom.localeCompare(b.prenom, 'fr'));

            const entete = COLONNES.map(c => celluleCSV(c.titre)).join(SEPARATEUR);
            const corps = lignes.map(l => COLONNES.map(c => celluleCSV(l[c.cle])).join(SEPARATEUR));
            const contenu = "﻿" + [entete, ...corps].join("\r\n") + "\r\n";

            preparedCsvBlob = new Blob([contenu], { type: 'text/csv;charset=utf-8;' });
            const date = new Date().toISOString().slice(0, 10);
            const libelle = nomFichierSur(ctx.libelleRacine);
            preparedFilename = `participants_${ctx.idRacine}${libelle ? "_" + libelle : ""}_${date}.csv`;

            setActionButtonState('download');
            log(`\n✅ Terminé ! ${ctx.campsTraites} camp(s) scanné(s), ${lignes.length} personne(s) unique(s)` +
                (ctx.doublons ? ` (${ctx.doublons} doublon(s) fusionné(s))` : "") +
                (ctx.erreurs ? `, ⚠️ ${ctx.erreurs} camp(s) en erreur` : "") + ".");
        }

        function declencherTelechargement() {
            if (!preparedCsvBlob) return;
            const url = URL.createObjectURL(preparedCsvBlob);
            const link = document.createElement("a");
            link.href = url;
            link.download = preparedFilename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        // --- Événements ---
        btn.onclick = () => {
            const idCamp = getCampIdFromUrl();
            if (!idCamp) return;
            $('sgdf-target-id').textContent = idCamp;
            if (actionBtn.dataset.state !== 'running') {
                $('sgdf-progress-wrapper').style.display = 'none';
                setActionButtonState('start');
            }
            modal.style.display = 'block';
            overlay.style.display = 'block';
        };

        const closeModal = () => {
            modal.style.display = 'none';
            overlay.style.display = 'none';
        };
        $('sgdf-close-btn').onclick = closeModal;
        overlay.onclick = closeModal;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'block') closeModal();
        });

        actionBtn.onclick = async () => {
            const state = actionBtn.dataset.state;
            if (state === 'download') return declencherTelechargement();
            if (state === 'running') {
                annulationDemandee = true;
                actionBtn.disabled = true;
                actionBtn.textContent = "Annulation...";
                return;
            }

            const idRacine = getCampIdFromUrl();
            if (!idRacine) return;

            annulationDemandee = false;
            preparedCsvBlob = null;
            setActionButtonState('running');
            $('sgdf-logs').textContent = "🚀 Initialisation...";
            updateProgress(0, "Démarrage...");

            const ctx = {
                idRacine,
                libelleRacine: "",
                token: rechercherToken(),
                inclureStaff: $('sgdf-opt-staff').checked,
                inclureEnfants: $('sgdf-opt-enfants').checked,
                personnes: new Map(),
                ordreCamps: new Map(),
                doublons: 0,
                erreurs: 0,
                campsTraites: 0,
            };

            log(ctx.token
                ? "🔑 Token d'authentification détecté."
                : "⚠️ Aucun token détecté. Tentative avec la session du navigateur...");
            log(`🏁 Lancement de l'extraction pour le camp ${idRacine}...`);

            try {
                const complet = await parcourirCamps(idRacine, ctx);
                if (!complet) {
                    updateProgress(0, "Annulé");
                    setActionButtonState('start');
                    return;
                }
                updateProgress(100, `Terminé ! (${ctx.campsTraites} camp(s))`);
                log("\n💾 Préparation du fichier CSV...");
                preparerCSV(ctx);
            } catch (e) {
                log(`💥 Erreur inattendue : ${e.message}`);
                setActionButtonState('start');
            }
        };
    }
})();
