// ==UserScript==
// @name         SGDF - Export Participants monprojet
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Exporte la liste des participants d'un camp en CSV
// @author       Clément Truillet
// @match        https://monprojet.sgdf.fr/*
// @updateURL    https://raw.githubusercontent.com/ctruillet/sgdf/main/monprojet_exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/ctruillet/sgdf/main/monprojet_exporter.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const API_URL_TEMPLATE = "https://monprojet.sgdf.fr/api/camps/{id}?module=ENTETE";
    let capturedAuthToken = null;
    let preparedCsvBlob = null;
    let preparedFilename = "";

    // --- Interception automatique du Token Bearer ---
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const headers = args[1]?.headers;
            if (headers) {
                let auth = null;
                if (headers instanceof Headers) {
                    auth = headers.get('Authorization') || headers.get('authorization');
                } else if (typeof headers === 'object') {
                    auth = headers['Authorization'] || headers['authorization'];
                }
                if (auth && auth.toLowerCase().startsWith('bearer ')) {
                    capturedAuthToken = auth;
                }
            }
        } catch (e) {}
        return originalFetch.apply(this, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function() {
        this._headers = {};
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (header && header.toLowerCase() === 'authorization' && value.toLowerCase().startsWith('bearer ')) {
            capturedAuthToken = value;
        }
        return originalSetRequestHeader.apply(this, arguments);
    };

    function searchStorageForToken() {
        if (capturedAuthToken) return capturedAuthToken;

        const storages = [localStorage, sessionStorage];
        for (const store of storages) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i);
                const val = store.getItem(key);
                if (val && typeof val === 'string' && val.includes('eyJ')) {
                    const match = val.match(/eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/);
                    if (match) {
                        return `Bearer ${match[0]}`;
                    }
                }
            }
        }
        return null;
    }

    window.addEventListener('DOMContentLoaded', initUI);

    function initUI() {
        // --- Styles CSS ---
        const style = document.createElement('style');
        style.innerHTML = `
            #sgdf-exporter-btn {
                position: fixed;
                bottom: 20px;
                left: 20px;
                z-index: 99999;
                background-color: #003366;
                color: #ffffff;
                border: none;
                padding: 12px 18px;
                border-radius: 25px;
                font-family: Arial, sans-serif;
                font-size: 14px;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                transition: all 0.2s ease;
            }
            #sgdf-exporter-btn:hover {
                background-color: #002244;
                transform: translateY(-2px);
            }
            #sgdf-exporter-modal {
                display: none;
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                z-index: 100000;
                width: 500px;
                max-width: 90%;
                background: #ffffff;
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.4);
                padding: 20px;
                font-family: Arial, sans-serif;
                color: #333;
            }
            #sgdf-exporter-overlay {
                display: none;
                position: fixed;
                top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.5);
                z-index: 99999;
            }
            #sgdf-exporter-modal h3 {
                margin-top: 0;
                color: #003366;
                border-bottom: 2px solid #eeeeee;
                padding-bottom: 10px;
            }
            /* Barre de progression */
            #sgdf-progress-wrapper {
                margin: 15px 0 10px 0;
                display: none;
            }
            #sgdf-progress-info {
                display: flex;
                justify-content: space-between;
                font-size: 12px;
                font-weight: bold;
                margin-bottom: 5px;
                color: #003366;
            }
            #sgdf-progress-container {
                width: 100%;
                background-color: #e0e0e0;
                border-radius: 10px;
                overflow: hidden;
                height: 16px;
                box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
            }
            #sgdf-progress-bar {
                width: 0%;
                height: 100%;
                background: linear-gradient(90deg, #003366, #0066cc);
                transition: width 0.3s ease;
            }
            #sgdf-logs {
                background: #f4f6f8;
                border: 1px solid #ddd;
                border-radius: 6px;
                height: 180px;
                overflow-y: auto;
                padding: 10px;
                font-family: monospace;
                font-size: 12px;
                margin: 10px 0 15px 0;
                white-space: pre-wrap;
            }
            .sgdf-btn {
                background: #003366;
                color: white;
                border: none;
                padding: 8px 15px;
                border-radius: 5px;
                cursor: pointer;
                font-weight: bold;
                transition: background-color 0.2s ease;
            }
            .sgdf-btn:disabled {
                background: #cccccc !important;
                cursor: not-allowed;
            }
            .sgdf-btn-success {
                background-color: #28a745 !important;
            }
            .sgdf-btn-success:hover {
                background-color: #218838 !important;
            }
            .sgdf-btn-secondary {
                background: #888;
                margin-left: 10px;
            }
        `;
        document.head.appendChild(style);

        // --- Injection UI ---
        const btn = document.createElement('button');
        btn.id = 'sgdf-exporter-btn';
        btn.innerText = '📊 Exporter les participants';
        document.body.appendChild(btn);

        const overlay = document.createElement('div');
        overlay.id = 'sgdf-exporter-overlay';
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'sgdf-exporter-modal';
        modal.innerHTML = `
            <h3>Exportation des Participants</h3>
            <p style="font-size: 13px; color: #555; margin-bottom: 5px;">Camp cible : <strong id="sgdf-target-id">-</strong></p>

            <div id="sgdf-progress-wrapper">
                <div id="sgdf-progress-info">
                    <span id="sgdf-progress-status">Traitement en cours...</span>
                    <span id="sgdf-progress-percent">0%</span>
                </div>
                <div id="sgdf-progress-container">
                    <div id="sgdf-progress-bar"></div>
                </div>
            </div>

            <div id="sgdf-logs">Cliquez sur "Démarrer l'export" pour lancer le traitement.</div>
            <div style="text-align: right;">
                <button id="sgdf-action-btn" class="sgdf-btn" data-state="start">Démarrer l'export</button>
                <button id="sgdf-close-btn" class="sgdf-btn sgdf-btn-secondary">Fermer</button>
            </div>
        `;
        document.body.appendChild(modal);

        // --- Logic Utilities ---
        function log(message) {
            const logBox = document.getElementById('sgdf-logs');
            logBox.innerText += "\n" + message;
            logBox.scrollTop = logBox.scrollHeight;
        }

        function clearLogs() {
            document.getElementById('sgdf-logs').innerText = "🚀 Initialisation...";
        }

        function updateProgress(percent, statusText) {
            const wrapper = document.getElementById('sgdf-progress-wrapper');
            const bar = document.getElementById('sgdf-progress-bar');
            const percentLabel = document.getElementById('sgdf-progress-percent');
            const statusLabel = document.getElementById('sgdf-progress-status');

            wrapper.style.display = 'block';
            const clamped = Math.min(100, Math.max(0, Math.round(percent)));
            bar.style.width = clamped + '%';
            percentLabel.innerText = clamped + '%';
            if (statusText) statusLabel.innerText = statusText;
        }

        function getCampIdFromUrl() {
            const match = window.location.pathname.match(/\/camp\/(\d+)/);
            return match ? match[1] : null;
        }

        function processAdherent(adh, idCamp, listeGlobale, clesUniques) {
            if (!adh) return;

            const prenom = String(adh.prenom || "").trim().toUpperCase();
            const nom = String(adh.nom || "").trim().toUpperCase();

            if (!prenom || !nom) return;

            const cle = `${prenom}_${nom}`;
            if (!clesUniques.has(cle)) {
                clesUniques.add(cle);

                let dateFormatee = "";
                const dateBrute = String(adh.dateNaissance || "");
                if (dateBrute.length >= 10) {
                    const parts = dateBrute.substring(0, 10).split("-");
                    if (parts.length === 3) {
                        dateFormatee = `${parts[2]}/${parts[1]}/${parts[0]}`;
                    }
                }

                listeGlobale.push({
                    prenom: prenom,
                    nom: nom,
                    dateNaissance: dateFormatee,
                    idCamp: idCamp
                });
            }
        }

        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // Scanner récursif
        async function scanner(idCamp, token, listeGlobale, clesUniques, tracker) {
            log(`📡 Extraction du camp ${idCamp}...`);
            const url = API_URL_TEMPLATE.replace("{id}", idCamp);

            const headers = {
                "Accept": "application/json, text/plain, */*"
            };
            if (token) {
                headers["Authorization"] = token;
            }

            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: headers,
                    credentials: "include"
                });

                if (!response.ok) {
                    log(`⚠️ Erreur ${response.status} sur le camp ${idCamp}`);
                    return;
                }

                const data = await response.json();

                // 1. Extraction (Participants + Staff)
                const blocs = ["campAdherentParticipants", "campAdherentStaffs"];
                for (const bloc of blocs) {
                    const items = data[bloc] || [];
                    for (const item of items) {
                        const adh = item.adherent ? item.adherent : item;
                        processAdherent(adh, idCamp, listeGlobale, clesUniques);
                    }
                }

                // Récupération des sous-camps pour ajuster le total estimé
                const enfants = data.campEnfants || [];
                tracker.estimatedTotal += enfants.length;

                // --- Fin de l'extraction de CE camp : Mise à jour de la barre ---
                tracker.processed++;
                const currentPct = (tracker.processed / tracker.estimatedTotal) * 100;
                const labelCamps = tracker.processed > 1 ? "camps extraits" : "camp extrait";
                updateProgress(currentPct, `Camp ${idCamp} extrait (${tracker.processed} ${labelCamps})`);

                // 2. Récursion sur les sous-camps (campEnfants)
                for (const enfant of enfants) {
                    if (enfant.id) {
                        await sleep(300);
                        await scanner(enfant.id, token, listeGlobale, clesUniques, tracker);
                    }
                }

            } catch (e) {
                log(`💥 Erreur sur le camp ${idCamp}: ${e.message}`);
            }
        }

        function preparerCSV(data, idRacine, campsCount) {
            if (data.length === 0) {
                log("⚠️ Aucun participant à exporter.");
                setActionButtonState('start');
                return;
            }

            let csvContent = "\uFEFF"; // BOM UTF-8
            csvContent += "Prénom;Nom;Date de Naissance;ID Camp\n";

            data.forEach(row => {
                csvContent += `"${row.prenom}";"${row.nom}";"${row.dateNaissance}";"${row.idCamp}"\n`;
            });

            preparedCsvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            preparedFilename = `participants_${idRacine}.csv`;

            setActionButtonState('download');
            log(`\n✅ Traitement terminé ! ${campsCount} camp(s) scanné(s), ${data.length} participants uniques prêts.`);
        }

        function setActionButtonState(state) {
            const actionBtn = document.getElementById('sgdf-action-btn');
            actionBtn.dataset.state = state;
            actionBtn.disabled = false;

            if (state === 'download') {
                actionBtn.innerText = "📥 Télécharger le CSV";
                actionBtn.classList.add('sgdf-btn-success');
            } else {
                actionBtn.innerText = "Démarrer l'export";
                actionBtn.classList.remove('sgdf-btn-success');
            }
        }

        function declencherTelechargement() {
            if (!preparedCsvBlob) return;

            const url = URL.createObjectURL(preparedCsvBlob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", preparedFilename);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }

        // --- Événements UI ---
        btn.onclick = () => {
            const idCamp = getCampIdFromUrl();
            if (!idCamp) {
                alert("Veuillez vous positionner sur la page d'un camp (ex: https://monprojet.sgdf.fr/camp/27011).");
                return;
            }

            document.getElementById('sgdf-target-id').innerText = idCamp;
            document.getElementById('sgdf-progress-wrapper').style.display = 'none';
            setActionButtonState('start');
            modal.style.display = 'block';
            overlay.style.display = 'block';
        };

        const closeModal = () => {
            modal.style.display = 'none';
            overlay.style.display = 'none';
        };

        document.getElementById('sgdf-close-btn').onclick = closeModal;
        overlay.onclick = closeModal;

        document.getElementById('sgdf-action-btn').onclick = async function() {
            if (this.dataset.state === 'download') {
                declencherTelechargement();
                return;
            }

            const idRacine = getCampIdFromUrl();
            if (!idRacine) return;

            this.disabled = true;
            preparedCsvBlob = null;
            clearLogs();
            updateProgress(0, "Démarrage...");

            const token = searchStorageForToken();
            if (token) {
                log(`🔑 Token d'authentification détecté.`);
            } else {
                log(`⚠️ Aucun token détecté automatiquement. Tentative en mode session directe...`);
            }

            const resultats = [];
            const doublons = new Set();
            const tracker = { processed: 0, estimatedTotal: 1 };

            log(`🏁 Lancement de l'extraction pour le camp ${idRacine}...`);
            await scanner(idRacine, token, resultats, doublons, tracker);

            updateProgress(100, `Terminé ! (${tracker.processed} camps extraits)`);
            log(`\n💾 Préparation du fichier CSV...`);
            preparerCSV(resultats, idRacine, tracker.processed);
        };
    }

})();
