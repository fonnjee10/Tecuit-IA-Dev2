# Tecuit IA v2

Backend Node.js + Frontend HTML complet.  
Aucune URL, aucun secret dans le code source public.

---

## Démarrage rapide

```bash
npm install
cp .env.example .env
# Éditez .env — mettez au moins HERMES_URL
node server.js
# → http://localhost:3000
```

---

## Configuration `.env`

| Variable        | Obligatoire | Description                                   |
|-----------------|-------------|-----------------------------------------------|
| `HERMES_URL`    | ✅           | URL de votre backend LLM (ngrok, Ollama…)    |
| `PORT`          | non         | Port du serveur (défaut: 3000)               |
| `KIWIX_URL`     | non         | URL de kiwix-serve (défaut: localhost:8080)  |
| `KIWIX_BOOK_ID` | non         | ID du livre Wikipedia (auto-détecté si vide) |
| `PIPER_BIN`     | non         | Chemin vers l'exécutable Piper TTS           |
| `PIPER_VOICE`   | non         | Chemin vers le fichier .onnx de la voix      |

---

## Kiwix — Wikipedia local

```bash
# 1. Télécharger kiwix-serve
# → https://download.kiwix.org/release/kiwix-tools/

# 2. Télécharger un fichier Wikipedia .zim
# → https://download.kiwix.org/zim/wikipedia/
#   Recommandé : wikipedia_fr_all_nopic_YYYY-MM.zim (~20 GB)

# 3. Lancer
./kiwix-serve --port=8080 wikipedia_fr_all_nopic_2024-01.zim
```

---

## Piper TTS — Voix locale naturelle (optionnel)

Sans Piper, la synthèse vocale utilise l'API du navigateur (qualité variable).  
Avec Piper, la voix est locale, naturelle, et sans internet.

```bash
# 1. Télécharger Piper
# → https://github.com/rhasspy/piper/releases/latest
#   piper_linux_x86_64.tar.gz  (ou Windows / macOS)

mkdir piper && tar xf piper_linux_x86_64.tar.gz -C piper/

# 2. Télécharger la voix française
mkdir voices
wget -P voices/ https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc-pierre/medium/fr_FR-upmc-pierre-medium.onnx
wget -P voices/ https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc-pierre/medium/fr_FR-upmc-pierre-medium.onnx.json

# 3. Configurer .env
PIPER_BIN=./piper/piper
PIPER_VOICE=./voices/fr_FR-upmc-pierre-medium.onnx
```

Autres voix disponibles sur : https://huggingface.co/rhasspy/piper-voices/tree/main/fr

---

## Fonctionnalités

- ✅ Chat SSE en streaming avec Hermes 4B / 7B
- ✅ Recherche web DuckDuckGo (instant answer + scraping)
- ✅ Wikipedia via Kiwix (base locale hors-ligne)
- ✅ TTS : Piper local (priorité) ou Web Speech API (fallback)
- ✅ STT : Web Speech API (micro → texte → envoi automatique)
- ✅ Lecture auto des réponses (toggle dans Options)
- ✅ Aucun secret dans le HTML
- ✅ Historique de conversations (localStorage)
- ✅ Export JSON
- ✅ Régénérer la dernière réponse
- ✅ Panneau de sources cliquables
- ✅ Rendu Markdown complet + coloration syntaxique
- ✅ Responsive mobile

---

## Structure

```
tecuit-v2/
├── server.js          ← Backend (secrets ici, jamais exposés)
├── package.json
├── .env.example       → copier en .env
├── .gitignore
├── README.md
├── voices/            ← fichiers .onnx Piper (à télécharger)
├── piper/             ← binaire Piper (à télécharger)
└── public/
    └── index.html     ← Frontend complet
```
