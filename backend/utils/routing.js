// Campus routing algorithm for DTU
// This implements pathfinding for campus navigation

class CampusRouter {
  constructor() {
    // Campus pathways and connections
    this.pathways = this.initializePathways();
    this.buildings = this.initializeBuildings();
  }

  initializePathways() {
    // Define main pathways on campus with coordinates
    // These would be based on actual campus layout
    return [
      {
        id: 'main_walkway_1',
        name: 'Main Central Walkway',
        coordinates: [
          [38.015, 11.849], [38.0155, 11.8495], [38.016, 11.85], 
          [38.0165, 11.8505], [38.017, 11.851]
        ],
        type: 'walkway',
        indoor: false
      },
      {
        id: 'library_path',
        name: 'Library Access Path',
        coordinates: [
          [38.0158, 11.8498], [38.0159, 11.8499], [38.016, 11.85]
        ],
        type: 'path',
        indoor: false
      },
      {
        id: 'admin_corridor',
        name: 'Administration Building Corridor',
        coordinates: [
          [38.0168, 11.8508], [38.0169, 11.8509], [38.017, 11.851]
        ],
        type: 'corridor',
        indoor: true
      }
    ];
  }

  initializeBuildings() {
    // Define building entrances and connections
    return {
      'Library Building': {
        entrance: [38.016, 11.85],
        connectedPathways: ['main_walkway_1', 'library_path']
      },
      'Admin Building': {
        entrance: [38.017, 11.851],
        connectedPathways: ['main_walkway_1', 'admin_corridor']
      },
      'Student Center': {
        entrance: [38.015, 11.849],
        connectedPathways: ['main_walkway_1']
      }
    };
  }

  // Calculate distance between two points (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI/180);
  }

  // Find shortest path using A* algorithm
  findShortestPath(startPOI, endPOI, routeType = 'walking') {
    const start = [startPOI.longitude, startPOI.latitude];
    const end = [endPOI.longitude, endPOI.latitude];
    
    // Simple direct path calculation for demo
    // In production, this would use proper pathfinding
    const path = this.generatePath(start, end);
    const distance = this.calculateDistance(
      startPOI.latitude, startPOI.longitude,
      endPOI.latitude, endPOI.longitude
    );

    return {
      path,
      distance: Math.round(distance),
      estimated_time: Math.round(distance / 1.4 / 60), // Walking speed 1.4 m/s
      instructions: this.generateInstructions(startPOI, endPOI, path)
    };
  }

  generatePath(start, end) {
    // Generate a smooth path with intermediate points
    const numPoints = 10;
    const path = [];
    
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const lng = start[0] + (end[0] - start[0]) * t;
      const lat = start[1] + (end[1] - start[1]) * t;
      path.push([lng, lat]);
    }
    
    return path;
  }

  generateInstructions(startPOI, endPOI, path) {
    const instructions = [];
    
    instructions.push({
      step: 1,
      instruction: `Start from ${startPOI.name}`,
      distance: 0,
      duration: 0
    });

    instructions.push({
      step: 2,
      instruction: `Walk towards ${endPOI.building}`,
      distance: Math.round(this.calculateDistance(
        startPOI.latitude, startPOI.longitude,
        endPOI.latitude, endPOI.longitude
      ) / 2),
      duration: 2
    });

    instructions.push({
      step: 3,
      instruction: `Continue on the main pathway`,
      distance: Math.round(this.calculateDistance(
        startPOI.latitude, startPOI.longitude,
        endPOI.latitude, endPOI.longitude
      ) / 4),
      duration: 1
    });

    instructions.push({
      step: 4,
      instruction: `Arrive at ${endPOI.name}`,
      distance: 0,
      duration: 0
    });

    return instructions;
  }
}

// Initialize router singleton
const campusRouter = new CampusRouter();

// Main route calculation function
async function calculateRoute(startPOI, endPOI, routeType = 'walking') {
  try {
    const route = campusRouter.findShortestPath(startPOI, endPOI, routeType);
    
    return {
      distance: route.distance,
      estimated_time: route.estimated_time,
      indoor_instructions: route.instructions,
      path_data: {
        coordinates: route.path,
        type: 'LineString'
      }
    };
  } catch (error) {
    console.error('Route calculation error:', error);
    throw new Error('Failed to calculate route');
  }
}

module.exports = { calculateRoute, campusRouter };