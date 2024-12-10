const THREE = AFRAME.THREE;

AFRAME.registerComponent('csg-meshs', {
    schema: {
        union: { type: 'selectorAll' },
        subtract: { type: 'selectorAll' },
        intersect: { type: 'selectorAll' }
    },

    getBSPs(o, list = []) {
        if (Array.isArray(o)) {
            o.forEach(c => this.getBSPs(c, list));
            return list;
        }
        if (o instanceof THREE.Object3D) {
            if (o.isMesh && o.geometry) {
                let geometry = o.geometrySimple || o.geometryOriginal || o.geometry;
                if (!(geometry instanceof THREE.BufferGeometry)) {
                    geometry = THREE.BufferGeometryUtils.fromGeometry(geometry);
                }
                let changed = !(o.bsp && o.bsp.matrixWorld.equals(o.matrixWorld));
                if (changed) {
                    this.changed = true;
                    const matrix = o.matrixWorld.clone();
                    o.bsp = new ThreeBSP(geometry, matrix);
                    o.bsp.mesh = o;
                    o.bsp.matrixWorld = o.matrixWorld.clone();
                }
                list.push(o.bsp);
            } else {
                this.getBSPs(o.children, list);
            }
        }
        return list;
    },

    tick() {
        this.changed = false;
        const source = this.getBSPs(this.el.object3D);
        const keys = Object.keys(this.data).filter(key => this.data[key]);
        const sets = {};
        keys.forEach(key => sets[key] = this.getBSPs(this.data[key].map(el => el.object3D)));
        if (this.changed) {
            source.forEach(a => {
                let x = a;
                keys.forEach(key => sets[key].forEach(b => x = x[key](b)));
                a.mesh.geometryOriginal = a.mesh.geometry;
                a.mesh.geometry = x.toGeometry();
            });
        }
    },
});

var EPSILON = 1e-5,
    COPLANAR = 0,
    FRONT = 1,
    BACK = 2,
    SPANNING = 3;

function ThreeBSP(geometry, matrix) {
    this.matrix = matrix;

    if (geometry instanceof ThreeBSP.Node) {
        this.tree = geometry;
        return this;
    } else {
        this.matrix = matrix;
    }

    const polygons = [];

    const posAttr = geometry.getAttribute('position');
    const normalAttr = geometry.getAttribute('normal');
    const uvAttr = geometry.getAttribute('uv');
    const indexAttr = geometry.getIndex();

    let indices;
    if (indexAttr) {
        indices = indexAttr.array;
    } else {
        indices = [];
        for (let i = 0; i < posAttr.count; i++) {
            indices.push(i);
        }
    }

    for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i];
        const ib = indices[i + 1];
        const ic = indices[i + 2];

        const a = getVertex(posAttr, normalAttr, uvAttr, ia, matrix);
        const b = getVertex(posAttr, normalAttr, uvAttr, ib, matrix);
        const c = getVertex(posAttr, normalAttr, uvAttr, ic, matrix);

        const polygon = new ThreeBSP.Polygon([a, b, c]);
        polygon.calculateProperties();
        polygons.push(polygon);
    }

    this.tree = new ThreeBSP.Node(polygons);
}

function getVertex(posAttr, normalAttr, uvAttr, i, matrix) {
    let x = posAttr.getX(i);
    let y = posAttr.getY(i);
    let z = posAttr.getZ(i);

    const normal = normalAttr ? new THREE.Vector3(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i)) : new THREE.Vector3();
    const uv = uvAttr ? new THREE.Vector2(uvAttr.getX(i), uvAttr.getY(i)) : new THREE.Vector2();

    const vertex = new ThreeBSP.Vertex(x, y, z, normal, uv);
    vertex.applyMatrix4(matrix);
    return vertex;
}

ThreeBSP.prototype.subtract = function (other_tree) {
    var a = this.tree.clone(),
        b = other_tree.tree.clone();

    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
    a = new ThreeBSP(a, this.matrix);
    return a;
};

ThreeBSP.prototype.union = function (other_tree) {
    var a = this.tree.clone(),
        b = other_tree.tree.clone();

    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a = new ThreeBSP(a, this.matrix);
    return a;
};

ThreeBSP.prototype.intersect = function (other_tree) {
    var a = this.tree.clone(),
        b = other_tree.tree.clone();

    a.invert();
    b.clipTo(a);
    b.invert();
    a.clipTo(b);
    b.clipTo(a);
    a.build(b.allPolygons());
    a.invert();
    a = new ThreeBSP(a, this.matrix);
    return a;
};

ThreeBSP.prototype.toGeometry = function () {
    const polygons = this.tree.allPolygons();
    const positions = [];
    const normals = [];
    const uvs = [];

    const invMatrix = new THREE.Matrix4().copy(this.matrix).invert();

    for (let i = 0; i < polygons.length; i++) {
        const polygon = polygons[i];
        for (let j = 2; j < polygon.vertices.length; j++) {
            const vA = polygon.vertices[0];
            const vB = polygon.vertices[j - 1];
            const vC = polygon.vertices[j];

            addVertexToArrays(vA, invMatrix, positions, normals, uvs, polygon.normal);
            addVertexToArrays(vB, invMatrix, positions, normals, uvs, polygon.normal);
            addVertexToArrays(vC, invMatrix, positions, normals, uvs, polygon.normal);
        }
    }

    const bufferGeometry = new THREE.BufferGeometry();
    const posArray = new Float32Array(positions);
    bufferGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const normArray = new Float32Array(normals);
    bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    if (uvs.length > 0) {
        const uvArray = new Float32Array(uvs);
        bufferGeometry.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    }

    bufferGeometry.computeBoundingSphere();
    bufferGeometry.computeBoundingBox();

    return bufferGeometry;
};

function addVertexToArrays(vertex, invMatrix, positions, normals, uvs, faceNormal) {
    const vPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
    vPos.applyMatrix4(invMatrix);

    positions.push(vPos.x, vPos.y, vPos.z);

    let n = vertex.normal.clone();
    if (n.length() < EPSILON) {
        n = faceNormal;
    }
    normals.push(n.x, n.y, n.z);

    uvs.push(vertex.uv.x, vertex.uv.y);
}

ThreeBSP.prototype.toMesh = function (material) {
    var geometry = this.toGeometry(),
        mesh = new THREE.Mesh(geometry, material);

    mesh.position.setFromMatrixPosition(this.matrix);
    const m = new THREE.Matrix4();
    m.extractRotation(this.matrix);
    mesh.rotation.setFromRotationMatrix(m);

    return mesh;
};


ThreeBSP.Polygon = function (vertices, normal, w) {
    if (!(vertices instanceof Array)) {
        vertices = [];
    }

    this.vertices = vertices;
    if (vertices.length > 0) {
        this.calculateProperties();
    } else {
        this.normal = this.w = undefined;
    }
};
ThreeBSP.Polygon.prototype.calculateProperties = function () {
    var a = this.vertices[0],
        b = this.vertices[1],
        c = this.vertices[2];

    this.normal = b.clone().subtract(a).cross(
        c.clone().subtract(a)
    ).normalize();

    this.w = this.normal.clone().dot(a);

    return this;
};
ThreeBSP.Polygon.prototype.clone = function () {
    var polygon = new ThreeBSP.Polygon();
    for (var i = 0; i < this.vertices.length; i++) {
        polygon.vertices.push(this.vertices[i].clone());
    }
    polygon.calculateProperties();
    return polygon;
};

ThreeBSP.Polygon.prototype.flip = function () {
    this.normal.multiplyScalar(-1);
    this.w *= -1;

    this.vertices.reverse();
    return this;
};
ThreeBSP.Polygon.prototype.classifyVertex = function (vertex) {
    var side_value = this.normal.dot(vertex) - this.w;

    if (side_value < -EPSILON) {
        return BACK;
    } else if (side_value > EPSILON) {
        return FRONT;
    } else {
        return COPLANAR;
    }
};
ThreeBSP.Polygon.prototype.classifySide = function (polygon) {
    var num_positive = 0,
        num_negative = 0,
        vertice_count = polygon.vertices.length;

    for (var i = 0; i < vertice_count; i++) {
        var classification = this.classifyVertex(polygon.vertices[i]);
        if (classification === FRONT) {
            num_positive++;
        } else if (classification === BACK) {
            num_negative++;
        }
    }

    if (num_positive > 0 && num_negative === 0) {
        return FRONT;
    } else if (num_positive === 0 && num_negative > 0) {
        return BACK;
    } else if (num_positive === 0 && num_negative === 0) {
        return COPLANAR;
    } else {
        return SPANNING;
    }
};
ThreeBSP.Polygon.prototype.splitPolygon = function (polygon, coplanar_front, coplanar_back, front, back) {
    var classification = this.classifySide(polygon);

    if (classification === COPLANAR) {
        (this.normal.dot(polygon.normal) > 0 ? coplanar_front : coplanar_back).push(polygon);
    } else if (classification === FRONT) {
        front.push(polygon);
    } else if (classification === BACK) {
        back.push(polygon);
    } else {
        var f = [], b = [];
        for (var i = 0; i < polygon.vertices.length; i++) {
            var j = (i + 1) % polygon.vertices.length;
            var vi = polygon.vertices[i];
            var vj = polygon.vertices[j];
            var ti = this.classifyVertex(vi);
            var tj = this.classifyVertex(vj);

            if (ti != BACK) f.push(vi);
            if (ti != FRONT) b.push(vi);
            if ((ti | tj) === SPANNING) {
                var t = (this.w - this.normal.dot(vi)) / this.normal.dot(vj.clone().subtract(vi));
                var v = vi.interpolate(vj, t);
                f.push(v);
                b.push(v);
            }
        }

        if (f.length >= 3) front.push(new ThreeBSP.Polygon(f).calculateProperties());
        if (b.length >= 3) back.push(new ThreeBSP.Polygon(b).calculateProperties());
    }
};

ThreeBSP.Vertex = function (x, y, z, normal, uv) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.normal = normal || new THREE.Vector3();
    this.uv = uv || new THREE.Vector2();
};
ThreeBSP.Vertex.prototype.clone = function () {
    return new ThreeBSP.Vertex(this.x, this.y, this.z, this.normal.clone(), this.uv.clone());
};
ThreeBSP.Vertex.prototype.add = function (vertex) {
    this.x += vertex.x;
    this.y += vertex.y;
    this.z += vertex.z;
    return this;
};
ThreeBSP.Vertex.prototype.subtract = function (vertex) {
    this.x -= vertex.x;
    this.y -= vertex.y;
    this.z -= vertex.z;
    return this;
};
ThreeBSP.Vertex.prototype.multiplyScalar = function (scalar) {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
};
ThreeBSP.Vertex.prototype.cross = function (vertex) {
    var x = this.x,
        y = this.y,
        z = this.z;

    this.x = y * vertex.z - z * vertex.y;
    this.y = z * vertex.x - x * vertex.z;
    this.z = x * vertex.y - y * vertex.x;

    return this;
};
ThreeBSP.Vertex.prototype.normalize = function () {
    var length = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);

    this.x /= length;
    this.y /= length;
    this.z /= length;

    return this;
};
ThreeBSP.Vertex.prototype.dot = function (vertex) {
    return this.x * vertex.x + this.y * vertex.y + this.z * vertex.z;
};
ThreeBSP.Vertex.prototype.lerp = function (a, t) {
    this.add(
        a.clone().subtract(this).multiplyScalar(t)
    );

    this.normal.add(
        a.normal.clone().sub(this.normal).multiplyScalar(t)
    );

    this.uv.add(
        a.uv.clone().sub(this.uv).multiplyScalar(t)
    );

    return this;
};
ThreeBSP.Vertex.prototype.interpolate = function (other, t) {
    return this.clone().lerp(other, t);
};
ThreeBSP.Vertex.prototype.applyMatrix4 = function (m) {
    var x = this.x, y = this.y, z = this.z;
    var e = m.elements;

    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];

    return this;
};

ThreeBSP.Node = function (polygons) {
    this.polygons = [];
    this.front = this.back = undefined;

    if (!(polygons instanceof Array) || polygons.length === 0) return;

    this.divider = polygons[0].clone();

    var front = [];
    var back = [];

    for (var i = 0; i < polygons.length; i++) {
        this.divider.splitPolygon(polygons[i], this.polygons, this.polygons, front, back);
    }

    if (front.length > 0) {
        this.front = new ThreeBSP.Node(front);
    }

    if (back.length > 0) {
        this.back = new ThreeBSP.Node(back);
    }
};

ThreeBSP.Node.isConvex = function (polygons) {
    for (var i = 0; i < polygons.length; i++) {
        for (var j = 0; j < polygons.length; j++) {
            if (i !== j && polygons[i].classifySide(polygons[j]) !== BACK) {
                return false;
            }
        }
    }
    return true;
};

ThreeBSP.Node.prototype.build = function (polygons) {
    if (!this.divider) {
        this.divider = polygons[0].clone();
    }

    var front = [];
    var back = [];

    for (var i = 0; i < polygons.length; i++) {
        this.divider.splitPolygon(polygons[i], this.polygons, this.polygons, front, back);
    }

    if (front.length > 0) {
        if (!this.front) this.front = new ThreeBSP.Node();
        this.front.build(front);
    }

    if (back.length > 0) {
        if (!this.back) this.back = new ThreeBSP.Node();
        this.back.build(back);
    }
};

ThreeBSP.Node.prototype.allPolygons = function () {
    var polygons = this.polygons.slice();
    if (this.front) polygons = polygons.concat(this.front.allPolygons());
    if (this.back) polygons = polygons.concat(this.back.allPolygons());
    return polygons;
};

ThreeBSP.Node.prototype.clone = function () {
    var node = new ThreeBSP.Node();

    node.divider = this.divider.clone();
    node.polygons = this.polygons.map(function (polygon) {
        return polygon.clone();
    });
    node.front = this.front && this.front.clone();
    node.back = this.back && this.back.clone();

    return node;
};

ThreeBSP.Node.prototype.invert = function () {
    for (var i = 0; i < this.polygons.length; i++) {
        this.polygons[i].flip();
    }

    this.divider.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();

    var temp = this.front;
    this.front = this.back;
    this.back = temp;

    return this;
};

ThreeBSP.Node.prototype.clipPolygons = function (polygons) {
    if (!this.divider) return polygons.slice();

    var front = [], back = [];

    for (var i = 0; i < polygons.length; i++) {
        this.divider.splitPolygon(polygons[i], front, back, front, back);
    }

    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back = [];

    return front.concat(back);
};

ThreeBSP.Node.prototype.clipTo = function (node) {
    this.polygons = node.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(node);
    if (this.back) this.back.clipTo(node);
};
