const {Hotel, validate} = require('../models/hotel');
const Room = require('../models/room');
const Joi = require('joi');
const _ = require('lodash');
const config = require('config');
const bcrypt = require('bcrypt');
const auth = require('../middleware/auth');
const express = require('express');
const router = express.Router();

const hotelData = config.get('hotelData');

// My Hotel
router.get('/me', auth, (req, res) => {
    const hotel = req.hotel;
    res.send(_.pick(hotel, hotelData));
});

// GET hotel
router.get('/:name', async (req, res) => {
    try {
        const name = req.params.name.trim();
        if (name.length < 3 || name.length > 55)
            return res.status(404).send('Hotel not found.');

        const hotel = await Hotel.findOne({ name });
        if (!hotel) return res.status(404).send('Hotel not found.');

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Create Hotel
router.post('/', async (req, res) => {
    try {
        const {error} = validate(req.body);
        if (error) return res.status(400).send(error.details[0].message);

        let hotel = await Hotel.findOne({ name: req.body.name });
        if (hotel) return res.status(400).send('Hotel\'s name already used.');
        
        hotel = new Hotel(_.pick(req.body, ['name', 'password', 'rooms', 'dateCreated']));
        hotel.initialize();
        const salt = await bcrypt.genSalt(10);
        hotel.password = await bcrypt.hash(hotel.password, salt);
        hotel = await hotel.save();

        const token = hotel.generateAuthToken();
        res.header('x-auth-token', token).send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Update Hotel's info
router.put('/update', auth, async (req, res) => {
    try {
        if (!req.body) return res.status(400).send('Invalid info.');

        let hotel = req.hotel;

        const {error} = validateRequest(req.body);
        if (error) return res.status(400).send('Invalid info.');

        if (req.body.name) hotel.name = req.body.name;
        if (req.body.password) {
            const salt = await bcrypt.genSalt(10);
            hotel.password = await bcrypt.hash(hotel.password, salt);
        }
    
        hotel = await hotel.save();

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

function validateRequest(req) {
    const schema = {
        name: Joi.string().min(3).max(55),
        password: Joi.string().min(8).max(255)
    };
    return Joi.validate(req, schema);
}

// GET Room by ID
router.get('/room/:roomID', auth, (req, res) => {
    try {
        const hotel = req.hotel;

        const room = hotel.findRoom(req.params.roomID);
        if (!room) res.status(400).send('Room with the given ID was not found.');
        
        res.send(room);
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Reserve Room
router.put('/room/reserve/:roomID/:owner', auth, async (req, res) => {
    try {
        let hotel = req.hotel;

        const roomID = parseInt(req.params.roomID); 
        if (roomID < 1 || roomID > hotel.rooms) 
            return res.status(400).send('Room with the given ID was not found.');

        const index = roomID - 1;
        const room = hotel.roomsList[index];

        if (room.isReserved) return res.status(400).send('Room already reserved.');

        room.owner = req.params.owner;
        room.isReserved = true;
        room.reservationDate = new Date();

        await Hotel.updateOne({ 'roomsList.ID': roomID }, 
        {
            $push: {
                reservedRoomsList: {
                    $each: [ room ],
                    $sort: { ID: 1 }
                }
            },
            $set: {
                'roomsList.$': room
            },
            $inc: {
                reservedRooms: 1
            }
        });
        
        hotel = await hotel.save();

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Checkout Room
router.put('/room/checkout/:roomID', auth, async (req, res) => {
    try {
        let hotel = req.hotel;

        const roomID = parseInt(req.params.roomID); 
        if (roomID < 1 || roomID > hotel.rooms) 
            return res.status(400).send('Room with the given ID was not found.');

        const index = roomID - 1;
        const room = hotel.roomsList[index];

        if (!room.isReserved) return res.send(400).send('Room is already empty.');

        room.owner = 'Unknown';
        room.isReserved = false;
        room.reservationDate = undefined;

        await Hotel.updateOne({ 'roomsList.ID': roomID },
        {
            $set: {
                'roomsList.$': room
            },
            $pull: {
                reservedRoomsList: { ID: roomID }
            },
            $inc: {
                reservedRooms: -1
            }
        });

        hotel = await hotel.save();

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Add Rooms to Hotel
router.put('/addRooms/:rooms', auth, async (req, res) => {
    try {
        let hotel = req.hotel;
        
        const rooms = parseInt(req.params.rooms);
        const totalRooms = hotel.rooms + rooms;
        let roomID = hotel.rooms + 1;

        const maxRooms = config.get('maxRooms');
        if (hotel.rooms + parseInt(req.params.rooms) > maxRooms)
            return res.status(400).send('Number of rooms is not allowed.');

        const roomsToUpdate = [ ...hotel.roomsList ];
        hotel.rooms += rooms;

        for ( ; roomID <= totalRooms; roomID++) roomsToUpdate.push(new Room('Unknown', roomID, 0));

        await Hotel.updateOne({ _id: req.hotel._id }, { $set: { roomsList: roomsToUpdate } });

        hotel = await hotel.save();

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        res.status(500).send('Something went wrong.');
    }
});

// Remove Rooms from Hotel
router.put('/removeRooms/:rooms', auth, async (req, res) => {
    try {
        let hotel = req.hotel;
        
        const newRooms = hotel.rooms - parseInt(req.params.rooms);
        if (newRooms <= 0) return res.status(400).send('Operation is not allowed.');

        const roomsToUpdate = [ ...hotel.roomsList ];
        roomsToUpdate.length = newRooms;
        hotel.rooms = newRooms;

        let roomsToRemove = 0;
        for (let i = hotel.reservedRoomsList.length - 1; i >= 0; i--) {
            if (hotel.reservedRoomsList[i].ID <= newRooms)
                break;
           --roomsToRemove;
        }

        await Hotel.updateOne({ _id: req.hotel._id }, 
            { 
                $set: { 
                    roomsList: roomsToUpdate
                },
                $inc: {
                    reservedRooms: roomsToRemove
                },
                $pull: { 
                    reservedRoomsList: { ID: { $gt: newRooms } } 
                }
            }, { multi: true });
        
        hotel = await hotel.save();

        res.send(_.pick(hotel, hotelData));
    }
    catch (ex) {
        console.log(ex.message);
        res.status(500).send('Something went wrong.');
    }
});

module.exports = router;