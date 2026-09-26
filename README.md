# DTU Campus Navigation

DTU Campus Navigation is a campus wayfinding web application for Debre Tabor University. It combines a Node.js/Express backend with a browser-based frontend to help users explore campus locations, view points of interest, and get route guidance between key places.

## Features

- Interactive campus map and route planning
- POI lookup and navigation to important locations
- Admin POI management tools
- Notification system and user-facing updates
- Feedback collection for campus improvements
- Multi-language interface support
- Real-time backend services with Socket.IO

## Project structure

- `backend/` — Express API, MongoDB configuration, models, routes, scripts, and utilities
- `frontend/` — UI, CSS, map assets, browser logic, and static app files
- `package.json` — root script entry points for running the app

## Requirements

- Node.js 18+
- MongoDB instance (or a reachable MongoDB connection string)

## Configuration

Create a `.env` file in the `backend` directory with the following values:

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/dtu-campus-navigation
JWT_SECRET=replace-with-a-strong-secret
FRONTEND_ORIGIN=http://localhost:8080
```

## Run the application

1. Install dependencies:

```bash
cd backend && npm install
cd ../frontend && npm install
```

2. Start the backend:

```bash
cd backend
npm run dev
```

3. Start the frontend:

```bash
cd frontend
npm start
```

4. Open the app in a browser:

- Frontend: `http://localhost:8080`
- Backend API: `http://localhost:5000/api/health`

## Useful scripts

From the project root:

```bash
npm run start
npm run start:backend
npm run start:frontend
```

## Notes

- The backend serves the frontend as static files when running in production mode.
- Admin tasks are available through the admin interface and backend scripts.
- The application stores POI and user data in MongoDB and exposes REST API routes under `/api`.
