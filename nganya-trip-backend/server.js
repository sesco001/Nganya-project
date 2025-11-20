require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');

const { setupSocket } = require('./socket');
const Passenger = require('./models/Passenger');
const Driver = require('./models/Driver');
const Booking = require('./models/Booking');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = setupSocket(server);

// -------------------- MONGO --------------------
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/nganya', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(()=>console.log('MongoDB Connected'))
.catch(err => console.error(err));

// -------------------- PASSENGER --------------------
// (same as before)
app.post('/api/passengers/register', async (req,res)=>{
    const { name, phone, email, password } = req.body;
    try{
        let p = await Passenger.findOne({ email });
        if(p) return res.json({ success:false, message:'Email already registered' });

        p = new Passenger({ name, phone, email, password });
        await p.save();
        res.json({ success:true, passenger:p, passengerId:p._id });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Error registering passenger' });
    }
});

app.post('/api/passengers/login', async (req,res)=>{
    const { email, password } = req.body;
    try{
        const p = await Passenger.findOne({ email: email.trim(), password: password.trim() });
        if(!p) return res.json({ success:false, message:'Invalid credentials' });
        res.json({ success:true, passenger:p, passengerId:p._id });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Login failed' });
    }
});

app.post('/api/passengers/bookings/request', async (req,res)=>{
    const { passengerId, driverId, pickup, dropoff } = req.body;
    try{
        const passenger = await Passenger.findById(passengerId);
        const driver = await Driver.findById(driverId);
        if(!passenger || !driver) return res.json({ success:false, message:'Passenger or driver not found' });

        const booking = new Booking({
            passenger: passengerId,
            driver: driverId,
            pickup,
            dropoff,
            status: 'pending'
        });
        await booking.save();

        io.to(driverId.toString()).emit('newBooking', {
            bookingId: booking._id,
            passenger: { name: passenger.name, phone: passenger.phone },
            pickup, dropoff
        });

        res.json({ success:true, booking });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Failed to create booking' });
    }
});

// -------------------- DRIVER --------------------
app.post('/api/drivers/register', async (req,res)=>{
    const { name, phone, password } = req.body;
    try{
        let d = await Driver.findOne({ phone });
        if(d) return res.json({ success:false, message:'Phone already registered' });

        d = new Driver({ name, phone, password, status:'pending' });
        await d.save();

        io.emit('newDriverApplication', { driverId: d._id, name:d.name, phone:d.phone });
        res.json({ success:true, driver:d, driverId:d._id });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Error registering driver' });
    }
});

app.post('/api/drivers/login', async (req,res)=>{
    const { phone, password } = req.body;
    try{
        const driver = await Driver.findOne({ phone: phone.trim(), password: password.trim() });
        if(!driver) return res.json({ success:false, message:'Invalid credentials' });
        if(driver.status !== 'approved') return res.json({ success:false, message:'Application not approved yet' });
        res.json({ success:true, driver, driverId:driver._id });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Login failed' });
    }
});

app.post('/api/drivers/application', async (req, res) => {
    const { driverId, vehicle, route, capacity } = req.body;
    try {
        const driver = await Driver.findById(driverId);
        if (!driver) return res.status(404).json({ success:false, message:'Driver not found' });

        driver.vehicle = vehicle;
        driver.route = route;
        driver.capacity = capacity;
        driver.status = 'pending';
        await driver.save();

        io.emit('newDriverApplication', { driverId: driver._id, name: driver.name, phone: driver.phone });
        res.json({ success:true, driver });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success:false, message:'Failed to submit application' });
    }
});

app.post('/api/drivers/toggleOnline', async (req,res)=>{
    const { driverId, isOnline } = req.body;
    try{
        const driver = await Driver.findById(driverId);
        if(!driver) return res.json({ success:false, message:'Driver not found' });

        driver.isOnline = isOnline;
        await driver.save();

        const driversOnline = await Driver.find({ isOnline:true, status:'approved' });
        io.emit('driversOnlineList', driversOnline.map(d=>({
            _id: d._id,
            name: d.name,
            vehicle: d.vehicle,
            route: d.route,
            capacity: d.capacity
        })));
        res.json({ success:true });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Failed to toggle online' });
    }
});

app.post('/api/drivers/bookings/accept', async (req,res)=>{
    const { driverId, bookingId } = req.body;
    try{
        const booking = await Booking.findById(bookingId).populate('driver passenger');
        if(!booking) return res.json({ success:false, message:'Booking not found' });

        booking.status = 'accepted';
        await booking.save();

        io.to(booking.passenger._id.toString()).emit('tripAccepted', {
            bookingId,
            driver: {
                _id: booking.driver._id,
                name: booking.driver.name,
                vehicle: booking.driver.vehicle,
                route: booking.driver.route
            },
            dropoffStage: booking.dropoff
        });

        res.json({ success:true });
    }catch(err){
        console.error(err);
        res.json({ success:false, message:'Failed to accept booking' });
    }
});

// -------------------- ADMIN FIX --------------------

// -------------------- ADMIN FIX --------------------

// Get all drivers
app.get('/api/drivers/all', async (req,res)=>{
    try{
        const drivers = await Driver.find();
        res.json(drivers);
    }catch(err){
        console.error(err);
        res.status(500).json({ success:false, message:'Failed to fetch drivers' });
    }
});

// Approve driver
app.post('/api/drivers/approve', async (req,res)=>{
    const { driverId } = req.body;
    if(!driverId) return res.status(400).json({ success:false, message:'Driver ID required' });

    try{
        const driver = await Driver.findById(driverId);
        if(!driver) return res.status(404).json({ success:false, message:'Driver not found' });

        driver.status = 'approved';
        await driver.save();

        // Emit updated online drivers
        const driversOnline = await Driver.find({ isOnline:true, status:'approved' });
        io.emit('driversOnlineList', driversOnline.map(d=>({
            _id: d._id,
            name: d.name,
            vehicle: d.vehicle,
            route: d.route,
            capacity: d.capacity
        })));

        res.json({ success:true, driver });
    }catch(err){
        console.error(err);
        res.status(500).json({ success:false, message:'Failed to approve driver' });
    }
});

// Reject driver - MOVED OUTSIDE OF APPROVE ROUTE
app.post('/api/drivers/reject', async (req, res) => {
    const { driverId, reason } = req.body;

    if (!driverId)
        return res.status(400).json({ success: false, message: 'Driver ID required' });

    try {
        const driver = await Driver.findById(driverId);
        if (!driver)
            return res.status(404).json({ success: false, message: 'Driver not found' });

        driver.status = 'rejected';
        driver.rejectReason = reason || "No reason provided";
        driver.isOnline = false;
        await driver.save();

        res.json({ success: true, driver });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to reject driver' });
    }
});

// -------------------- SOCKET.IO --------------------
const onlineDrivers = new Map();

io.on('connection', socket=>{
    console.log('Socket connected:', socket.id);

    socket.on('joinDriver', driverId=>{
        socket.join(driverId.toString());
        onlineDrivers.set(driverId.toString(), socket.id);

        Driver.find({ isOnline:true, status:'approved' }).then(drivers=>{
            io.emit('driversOnlineList', drivers.map(d=>({
                _id: d._id,
                name: d.name,
                vehicle: d.vehicle,
                route: d.route,
                capacity: d.capacity
            })));
        });
    });

    socket.on('joinPassenger', passengerId=>{
        socket.join(passengerId.toString());
    });

    socket.on('passengerGPS', data=>{
        if(data.driverId) socket.to(data.driverId.toString()).emit('driverGPSUpdate', { lat:data.lat, lng:data.lng });
    });

    socket.on('getOnlineDrivers', async ()=>{
        try{
            const drivers = await Driver.find({ isOnline:true, status:'approved' });
            socket.emit('driversOnlineList', drivers.map(d=>({
                _id: d._id,
                name: d.name,
                vehicle: d.vehicle,
                route: d.route,
                capacity: d.capacity
            })));
        }catch(err){
            console.error('Failed to fetch online drivers:', err);
        }
    });

    socket.on('disconnect', ()=>{
        for(const [driverId, sId] of onlineDrivers.entries()){
            if(sId === socket.id) onlineDrivers.delete(driverId);
        }
        Driver.find({ isOnline:true, status:'approved' }).then(drivers=>{
            io.emit('driversOnlineList', drivers.map(d=>({
                _id: d._id,
                name: d.name,
                vehicle: d.vehicle,
                route: d.route,
                capacity: d.capacity
            })));
        });
    });
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, ()=>console.log(`Server running on ${PORT}`));
